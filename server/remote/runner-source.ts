/**
 * Remote, credential-free JSONL tool runner. Keep this as a string so packaged
 * desktop builds do not depend on a loose Python source file.
 */
export const REMOTE_RUNNER_SOURCE = String.raw`#!/usr/bin/env python3
import json
import os
import platform
import fcntl
import hashlib
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

MAX_FRAME = 1024 * 1024
MAX_TEXT = 128 * 1024
MAX_EDIT_FILE = 32 * 1024 * 1024
MAX_READ_CHUNK = 48 * 1024
MAX_OUTPUT = 256 * 1024
read_progress = {}
MAX_TIMEOUT = 300000
TOOLS = {"exec", "read_file", "write_file", "replace_text", "list", "stat", "search", "git", "diagnose"}
GIT_READ_COMMANDS = {"status", "diff", "log"}
lock = threading.RLock()
running = {}
last_heartbeat = time.monotonic()
stopping = threading.Event()
write_lock = threading.Lock()
edit_lock = threading.Lock()

def send(value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(data) > MAX_FRAME:
        data = json.dumps({"id": value.get("id"), "ok": False, "error": "response exceeds frame limit"}, separators=(",", ":")).encode() + b"\n"
    with write_lock:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

def within_root(raw):
    if not isinstance(raw, str) or "\x00" in raw:
        raise ValueError("path must be a string")
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(ROOT)
    except ValueError:
        raise ValueError("path escapes project root")
    return resolved

def validate_keys(args, allowed, required):
    if not isinstance(args, dict):
        raise ValueError("args must be an object")
    if set(args) - set(allowed) or set(required) - set(args):
        raise ValueError("tool arguments do not match the supported schema")

def cwd_for(args):
    path = within_root(args.get("cwd", str(ROOT)))
    if not path.is_dir():
        raise ValueError("cwd is not a directory")
    return path

def read_file(args):
    validate_keys(args, ("path", "offset", "limit", "revision"), ("path",))
    path = within_root(args.get("path"))
    if not path.is_file():
        raise ValueError("file does not exist")
    offset = args.get("offset", 0)
    limit = args.get("limit", MAX_READ_CHUNK)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > MAX_READ_CHUNK:
        raise ValueError("read limit must be between 1 and 49152 bytes")
    supplied_revision = args.get("revision")
    if supplied_revision is not None and (not isinstance(supplied_revision, str) or len(supplied_revision) > 256):
        raise ValueError("revision must be a short string")
    before = path.stat()
    if offset > before.st_size:
        raise ValueError("offset exceeds file size")
    with path.open("rb") as stream:
        stream.seek(offset)
        data = stream.read(min(limit + 4, before.st_size - offset))
    data = data[:limit]
    # Return only complete UTF-8 characters; nextOffset is therefore safe to resume.
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as error:
        if error.reason == "unexpected end of data" and error.end == len(data):
            data = data[:error.start]
            content = data.decode("utf-8")
        elif offset > 0 and error.start == 0 and error.reason == "invalid start byte":
            raise ValueError("offset is not a UTF-8 boundary")
        else:
            raise ValueError("file is not valid UTF-8")
    if not data and before.st_size > offset:
        raise ValueError("read limit is too small for a UTF-8 character")
    after = path.stat()
    revision = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    revision_text = ":".join(str(part) for part in revision)
    if offset > 0 and supplied_revision != revision_text:
        raise ValueError("file changed while reading")
    after_revision = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
    if revision != after_revision:
        raise ValueError("file changed while reading")
    next_offset = offset + len(data)
    truncated = next_offset < before.st_size
    # Keep edit compatibility for persistent SSH runners; pagination correctness does not
    # depend on this cache because every continuation carries and validates its revision.
    read_progress[str(path)] = {"revision": revision, "next": next_offset, "complete": not truncated}
    return {"path": str(path), "content": data.decode("utf-8"), "offset": offset,
            "bytesRead": len(data), "totalBytes": before.st_size, "truncated": truncated,
            "nextOffset": next_offset, "revision": revision_text}

def write_file(args):
    validate_keys(args, ("path", "content", "readOnly"), ("path", "content"))
    if args.get("readOnly") is True:
        raise ValueError("write_file is disabled for a read-only call")
    path = within_root(args.get("path"))
    content = args.get("content")
    if not isinstance(content, str):
        raise ValueError("content must be a string")
    data = content.encode("utf-8")
    if len(data) > MAX_TEXT:
        raise ValueError("content exceeds write limit")
    if not path.parent.is_dir():
        raise ValueError("parent directory does not exist")
    fd, temporary = tempfile.mkstemp(prefix=".adelic-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return {"path": str(path), "bytesWritten": len(data)}

def replace_text(args):
    validate_keys(args, ("path", "oldText", "newText", "readOnly", "expectedRevision", "readRevision"), ("path", "oldText", "newText"))
    if args.get("readOnly") is True:
        raise ValueError("replace_text is disabled for a read-only call")
    with edit_lock:
        path = within_root(args.get("path"))
        # Lock files live in per-user temporary storage, never in the deliverable tree.
        # Local bwrap executors bind this same host directory so independent processes
        # contend on the same flock; SSH runners share it across their own processes.
        # Use the dedicated lock directory mounted at this stable namespace path.
        # The runner's private TMPDIR is process-local and must not isolate edit locks.
        lock_dir = Path("/tmp") / ("adelic-locks-" + str(os.getuid()))
        lock_dir.mkdir(mode=0o700, exist_ok=True)
        lock_info = lock_dir.lstat()
        if not stat.S_ISDIR(lock_info.st_mode) or lock_info.st_uid != os.getuid() or stat.S_IMODE(lock_info.st_mode) & 0o077:
            raise ValueError("invalid edit lock directory")
        relative_resource = path.relative_to(ROOT).as_posix()
        lock_name = hashlib.sha256(os.fsencode(WORKSPACE_ID + "\0" + relative_resource)).hexdigest() + ".lock"
        lock_path = lock_dir / lock_name
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("invalid edit lock")
            fcntl.flock(fd, fcntl.LOCK_EX)
            return _replace_text(args)
        finally:
            os.close(fd)

def _replace_text(args):
    validate_keys(args, ("path", "oldText", "newText", "readOnly", "expectedRevision", "readRevision"), ("path", "oldText", "newText"))
    if args.get("readOnly") is True:
        raise ValueError("replace_text is disabled for a read-only call")
    path = within_root(args.get("path"))
    old_text = args.get("oldText")
    new_text = args.get("newText")
    if not isinstance(old_text, str) or not old_text:
        raise ValueError("oldText must be a non-empty string")
    if not isinstance(new_text, str):
        raise ValueError("newText must be a string")
    old_bytes = old_text.encode("utf-8")
    new_bytes = new_text.encode("utf-8")
    if len(old_bytes) > MAX_TEXT or len(new_bytes) > MAX_TEXT:
        raise ValueError("replacement text exceeds limit")
    if not path.is_file():
        raise ValueError("file does not exist")
    expected_revision = args.get("expectedRevision")
    legacy_revision = args.get("readRevision")
    if expected_revision is not None and (not isinstance(expected_revision, str) or not expected_revision or len(expected_revision) > 256):
        raise ValueError("expectedRevision must be a short string")
    if legacy_revision is not None and (not isinstance(legacy_revision, str) or not legacy_revision or len(legacy_revision) > 256):
        raise ValueError("readRevision must be a short string")
    if expected_revision and legacy_revision and expected_revision != legacy_revision:
        raise ValueError("expectedRevision and readRevision do not match")
    supplied_revision = expected_revision or legacy_revision
    progress = read_progress.get(str(path))
    before = path.stat()
    current_revision = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    current_revision_text = ":".join(str(part) for part in current_revision)
    if before.st_size > MAX_EDIT_FILE:
        raise ValueError("file exceeds edit limit")
    if supplied_revision:
        if supplied_revision != current_revision_text:
            raise ValueError("file changed before edit")
    elif not (progress and progress["complete"] and progress["revision"] == current_revision):
        raise ValueError("file must be read completely before replace_text")
    with path.open("rb") as stream:
        content = stream.read(MAX_EDIT_FILE + 1)
    if len(content) > MAX_EDIT_FILE:
        raise ValueError("file exceeds edit limit")
    checked = path.stat()
    checked_revision = (checked.st_dev, checked.st_ino, checked.st_size, checked.st_mtime_ns, checked.st_ctime_ns)
    if checked_revision != current_revision or len(content) != before.st_size:
        raise ValueError("file changed before edit")
    content.decode("utf-8")
    first = content.find(old_bytes)
    second = content.find(old_bytes, first + 1) if first >= 0 else -1
    if first < 0 or second >= 0:
        raise ValueError("oldText must match exactly once")
    updated = content[:first] + new_bytes + content[first + len(old_bytes):]
    if len(updated) > MAX_EDIT_FILE:
        raise ValueError("edited file exceeds limit")
    fd, temporary = tempfile.mkstemp(prefix=".adelic-", dir=str(path.parent))
    try:
        os.fchmod(fd, stat.S_IMODE(path.stat().st_mode))
        with os.fdopen(fd, "wb") as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        latest = path.stat()
        latest_revision = (latest.st_dev, latest.st_ino, latest.st_size, latest.st_mtime_ns, latest.st_ctime_ns)
        if latest_revision != current_revision:
            raise ValueError("file changed before edit")
        os.replace(temporary, path)
        directory_fd = os.open(str(path.parent), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        except OSError:
            # The atomic replace already succeeded; some filesystems do not support directory fsync.
            pass
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    read_progress.pop(str(path), None)
    return {"path": str(path), "matches": 1, "bytesWritten": len(updated)}

def list_dir(args):
    validate_keys(args, ("path", "recursive", "limit"), ())
    path = within_root(args.get("path", "."))
    if not path.is_dir():
        raise ValueError("path is not a directory")
    limit = args.get("limit", 500)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 20000:
        raise ValueError("limit must be between 1 and 20000")
    recursive = args.get("recursive", False)
    if not isinstance(recursive, bool):
        raise ValueError("recursive must be a boolean")
    entries = []
    truncated = False
    if recursive:
        iterator = ((Path(base) / name) for base, dirs, files in os.walk(path, followlinks=False) for name in sorted(dirs) + sorted(files))
    else:
        iterator = iter(sorted(path.iterdir(), key=lambda entry: entry.name))
    bytes_used = 2
    for item in iterator:
        try:
            resolved = item.resolve(strict=False)
            resolved.relative_to(ROOT)
        except (OSError, ValueError):
            continue
        if len(entries) >= limit:
            truncated = True
            break
        entry = {"name": item.name, "path": str(item.relative_to(ROOT)), "directory": item.is_dir()}
        entry_size = len(json.dumps(entry, separators=(",", ":")).encode("utf-8")) + 1
        if bytes_used + entry_size > 512 * 1024:
            truncated = True
            break
        entries.append(entry)
        bytes_used += entry_size
    return {"entries": entries, "truncated": truncated}

def stat_path(args):
    validate_keys(args, ("path",), ("path",))
    path = within_root(args.get("path"))
    info = path.stat()
    return {"path": str(path), "type": "directory" if path.is_dir() else "file" if path.is_file() else "other", "size": info.st_size, "mtime": info.st_mtime}

def search(args):
    validate_keys(args, ("query", "path", "limit"), ("query",))
    query = args.get("query")
    if not isinstance(query, str) or not query:
        raise ValueError("query must be a non-empty string")
    if len(query) > 4096:
        raise ValueError("query is too long")
    root = within_root(args.get("path", "."))
    if not root.is_dir():
        raise ValueError("search path is not a directory")
    limit = args.get("limit", 100)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 1000:
        raise ValueError("limit must be between 1 and 1000")
    results = []
    omitted = {"tooLarge": 0, "unreadable": 0}
    response_bytes = 2
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name != ".git" and (Path(base) / name).resolve().is_relative_to(ROOT)]
        for name in files:
            file_path = Path(base) / name
            try:
                resolved = file_path.resolve(strict=True)
                resolved.relative_to(ROOT)
                if not resolved.is_file():
                    continue
                if resolved.stat().st_size > MAX_TEXT:
                    omitted["tooLarge"] += 1
                    continue
                content = resolved.read_text(encoding="utf-8")
            except (OSError, UnicodeError, ValueError):
                omitted["unreadable"] += 1
                continue
            for number, line in enumerate(content.splitlines(), 1):
                if query in line:
                    match = {"path": str(resolved), "line": number, "text": line[:2000]}
                    response_bytes += len(json.dumps(match, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
                    if response_bytes > 512 * 1024:
                        return {"results": results, "truncated": True, "omittedFiles": omitted}
                    results.append(match)
                    if len(results) >= limit:
                        return {"results": results, "truncated": True, "omittedFiles": omitted}
    return {"results": results, "truncated": False, "omittedFiles": omitted}

def terminate_process(proc, descendants=None):
    descendants = descendants or set()
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            proc.terminate()
        except OSError:
            pass
    for pid in descendants:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        proc.wait(timeout=1.5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
    for pid in descendants:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

def descendants_of(root_pid):
    children_by_parent = {}
    try:
        process_dirs = os.scandir("/proc")
    except OSError:
        return set()
    with process_dirs:
        for entry in process_dirs:
            if not entry.name.isdigit():
                continue
            try:
                raw = Path(entry.path, "stat").read_text()
                end = raw.rfind(")")
                fields = raw[end + 2:].split()
                children_by_parent.setdefault(int(fields[1]), []).append(int(entry.name))
            except (OSError, ValueError, IndexError):
                continue
    result = set()
    frontier = [root_pid]
    while frontier:
        parent = frontier.pop()
        children = [pid for pid in children_by_parent.get(parent, ()) if pid not in result]
        result.update(children)
        frontier.extend(children)
    return result

def run_process(command, cwd, timeout, request_id):
    if isinstance(command, str):
        if not command or len(command) > 32768:
            raise ValueError("command must be a non-empty string under 32768 characters")
        shell = True
    elif isinstance(command, list) and command and len(command) <= 256 and all(isinstance(part, str) and len(part) <= 8192 for part in command):
        shell = False
    else:
        raise ValueError("command must be a string or a non-empty string array")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > MAX_TIMEOUT:
        raise ValueError("timeoutMs must be between 1 and 300000")
    # The reader registers this event before starting the worker, so an immediate
    # cancel can prevent spawn. /proc snapshots also catch observed setsid children;
    # a child that reparents before a snapshot can still escape this best effort.
    with lock:
        state = running.get(request_id)
        if state is None:
            state = (None, threading.Event(), set())
            running[request_id] = state
        cancel = state[1]
        descendants = state[2]
        if cancel.is_set() or stopping.is_set():
            raise RuntimeError("command cancelled")
        proc = subprocess.Popen(command, shell=shell, cwd=str(cwd), env=dict(os.environ), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        running[request_id] = (proc, cancel, descendants)
    stdout = bytearray()
    stderr = bytearray()
    def drain(source, target):
        while True:
            chunk = source.read(8192)
            if not chunk:
                return
            available = MAX_OUTPUT - len(target)
            if available > 0:
                target.extend(chunk[:available])
    stdout_thread = threading.Thread(target=drain, args=(proc.stdout, stdout), daemon=True)
    stderr_thread = threading.Thread(target=drain, args=(proc.stderr, stderr), daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    deadline = time.monotonic() + timeout / 1000.0
    try:
        while proc.poll() is None:
            descendants.update(descendants_of(proc.pid))
            if cancel.is_set() or stopping.is_set():
                terminate_process(proc, descendants)
                raise RuntimeError("command cancelled")
            if time.monotonic() >= deadline:
                terminate_process(proc, descendants)
                raise TimeoutError("command timed out")
            time.sleep(0.025)
        if descendants:
            terminate_process(proc, descendants)
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        return {"exitCode": proc.returncode, "stdout": bytes(stdout).decode("utf-8", errors="replace"), "stderr": bytes(stderr).decode("utf-8", errors="replace")}
    finally:
        if proc.poll() is None:
            terminate_process(proc, descendants)
        proc.stdout.close()
        proc.stderr.close()

def diagnose_capabilities():
    names = ("git", "node", "npm", "python3", "pytest", "ssh", "bwrap", "chromium", "chromium-browser", "google-chrome", "firefox")
    binaries = {name: shutil.which(name) is not None for name in names}
    deadline = time.monotonic() + 2.0
    git_marker = (ROOT / ".git").exists()
    git_state = "unavailable" if not binaries["git"] else "binary-only"
    if binaries["git"]:
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("git rev-parse", 0)
            check = subprocess.run(["git", "-C", str(ROOT), "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks", "rev-parse", "--show-toplevel"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=remaining, check=False, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
            top = Path(check.stdout.decode("utf-8", errors="strict").strip()).resolve(strict=True) if check.returncode == 0 else None
            if top is not None and top.is_dir():
                git_state = "repository"
            elif git_marker:
                git_state = "unverified"
        except (OSError, UnicodeError, subprocess.TimeoutExpired, ValueError):
            git_state = "unverified" if git_marker else "binary-only"
    browsers = [name for name in ("chromium", "chromium-browser", "google-chrome", "firefox") if binaries[name]]
    browser_functional = []
    for name in browsers:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            result = subprocess.run([shutil.which(name), "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=remaining, check=False)
            if result.returncode == 0:
                browser_functional.append(name)
        except (OSError, subprocess.TimeoutExpired):
            pass
    return {"git": git_state,
            "tmp": {path: os.path.isdir(path) and os.access(path, os.W_OK) for path in ("/tmp", "/var/tmp")},
            "browsers": browsers,
            "browserFunctional": browser_functional,
            "binaries": binaries,
            "hostDependentTests": "Browser executables are listed separately from --version success; this does not verify GUI/browser automation. /tmp and /var/tmp are private writable scratch directories in this executor. Tests requiring desktop GUI, host services, host-only files, a host SSH account/agent or external networking may still require the host and may not run here."}

def execute(tool, args, request_id):
    if not isinstance(args, dict):
        raise ValueError("args must be an object")
    if tool == "read_file": return read_file(args)
    if tool == "write_file": return write_file(args)
    if tool == "replace_text": return replace_text(args)
    if tool == "list": return list_dir(args)
    if tool == "stat": return stat_path(args)
    if tool == "search": return search(args)
    if tool == "exec":
        validate_keys(args, ("command", "cwd", "timeoutMs", "readOnly"), ("command",))
        if args.get("readOnly") is True:
            raise ValueError("exec cannot guarantee a read-only filesystem")
        return run_process(args.get("command"), cwd_for(args), args.get("timeoutMs", 120000), request_id)
    if tool == "diagnose":
        validate_keys(args, (), ())
        return diagnose_capabilities()
    if tool == "git":
        validate_keys(args, ("args", "operation", "cwd", "timeoutMs", "readOnly"), ())
        operation = args.get("operation")
        supplied = args.get("args")
        if operation is None and isinstance(supplied, list) and len(supplied) == 1:
            operation = supplied[0]
        if operation not in GIT_READ_COMMANDS or args.get("readOnly") is False:
            raise ValueError("only read-only git commands are allowed")
        cwd = cwd_for(args)
        timeout = args.get("timeoutMs", 30000)
        # --no-textconv does not disable clean/process filters selected by attributes.
        # Read the effective config (including includes/worktree config) without running
        # repository helpers, then override every configured executable filter key.
        # This controls normal Git behavior, not a hostile same-uid config race.
        filters = run_process(["git", "-C", str(cwd), "config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|smudge|process|required)$"], cwd, timeout, request_id)
        if filters["exitCode"] not in (0, 1) or len(filters["stdout"].encode("utf-8")) >= MAX_OUTPUT or (filters["stdout"] and not filters["stdout"].endswith("\0")):
            raise ValueError("cannot safely read Git filter configuration")
        filter_keys = set(filters["stdout"].split("\0")) - {""}
        if len(filter_keys) > 1024:
            raise ValueError("Git filter configuration exceeds limit")
        filter_options = []
        for key in sorted(filter_keys):
            filter_options.extend(["-c", key + ("=false" if key.endswith(".required") else "=")])
        argv = ["git", "-C", str(cwd), *filter_options, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "core.untrackedCache=false", "-c", "log.showSignature=false", "-c", "submodule.recurse=false", "--no-pager", "--no-optional-locks", operation]
        if operation == "status":
            argv.append("--ignore-submodules=all")
        elif operation == "diff":
            argv.extend(["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"])
        if operation == "log":
            argv.extend(["-n", "20", "--oneline", "--no-ext-diff", "--no-textconv"])
        return run_process(argv, cwd, timeout, request_id)
    raise ValueError("unknown tool")

def process_request(request):
    request_id = request.get("id")
    try:
        if not isinstance(request_id, (str, int)) or isinstance(request_id, bool) or len(str(request_id)) > 128:
            raise ValueError("request id must be a short string or integer")
        if request.get("method") == "info":
            if set(request) != {"id", "method"}:
                raise ValueError("info request does not match the supported schema")
            capabilities = diagnose_capabilities()
            send({"id": request_id, "ok": True, "result": {"protocol": 1, "python": platform.python_version(), "platform": platform.system(), "root": str(ROOT), "capabilities": capabilities}})
            return
        if request.get("method") != "call" or request.get("tool") not in TOOLS:
            raise ValueError("unsupported method or tool")
        if set(request) != {"id", "method", "tool", "args"}:
            raise ValueError("call request does not match the supported schema")
        result = execute(request["tool"], request.get("args", {}), request_id)
        send({"id": request_id, "ok": True, "result": result})
    except Exception as exc:
        # Categorize by exception type and fixed, known validation cases. Never send arbitrary
        # exception text (which may contain paths, request values or credentials) over JSONL.
        detail = str(exc) if isinstance(exc, (ValueError, UnicodeError)) else ""
        if isinstance(exc, TimeoutError):
            category, message = "timeout", "command timed out"
        elif isinstance(exc, FileNotFoundError) or detail == "file does not exist":
            category, message = "not_found", "file does not exist"
        elif isinstance(exc, PermissionError):
            category, message = "permission", "permission denied"
        elif detail in ("file exceeds read limit", "offset exceeds file size", "offset is not a UTF-8 boundary", "read limit must be between 1 and 49152 bytes", "read limit is too small for a UTF-8 character", "unable to read UTF-8 boundary"):
            category, message = "invalid_request", detail
        elif detail == "file exceeds edit limit":
            category, message = "invalid_request", "file exceeds edit limit"
        elif isinstance(exc, UnicodeError) or detail == "file is not valid UTF-8":
            category, message = "invalid_request", "file is not valid UTF-8"
        elif detail in ("oldText must match exactly once", "file must be read completely before replace_text", "file changed before edit", "file changed while reading"):
            category, message = "conflict", detail
        elif detail == "parent directory does not exist":
            category, message = "not_found", "parent directory does not exist"
        elif detail == "path escapes project root":
            category, message = "invalid_request", "path escapes project root"
        elif isinstance(exc, FileExistsError):
            category, message = "conflict", "destination already exists"
        elif isinstance(exc, RuntimeError) and str(exc) == "command cancelled":
            category, message = "executor", "command cancelled"
        elif isinstance(exc, ValueError):
            category, message = "invalid_request", "invalid tool request or file"
        else:
            category, message = "executor", "remote tool failed"
        safe_messages = {
            "path must be a string", "path escapes project root", "args must be an object",
            "tool arguments do not match the supported schema", "cwd is not a directory",
            "write_file is disabled for a read-only call", "content must be a string",
            "content exceeds write limit", "replace_text is disabled for a read-only call",
            "file exceeds read limit", "file exceeds edit limit", "file is not valid UTF-8",
            "file must be read completely before replace_text", "file changed before edit", "file changed while reading",
            "offset exceeds file size", "offset is not a UTF-8 boundary",
            "read limit must be between 1 and 49152 bytes", "read limit is too small for a UTF-8 character",
            "unable to read UTF-8 boundary",
            "oldText must be a non-empty string", "newText must be a string",
            "replacement text exceeds limit", "edited file exceeds limit", "path is not a directory",
            "limit must be between 1 and 20000", "recursive must be a boolean",
            "query must be a non-empty string", "query is too long", "search path is not a directory",
            "limit must be between 1 and 1000", "command must be a non-empty string under 32768 characters",
            "command must be a string or a non-empty string array", "timeoutMs must be between 1 and 300000",
            "exec cannot guarantee a read-only filesystem", "only read-only git commands are allowed",
            "cannot safely read Git filter configuration", "Git filter configuration exceeds limit",
            "unknown tool", "request id must be a short string or integer",
            "info request does not match the supported schema", "unsupported method or tool",
            "call request does not match the supported schema",
        }
        if detail in safe_messages:
            message = detail
        send({"id": request_id, "ok": False, "error": message, "errorCategory": category})
    finally:
        if isinstance(request_id, (str, int)) and not isinstance(request_id, bool):
            with lock:
                running.pop(request_id, None)

def watchdog():
    global last_heartbeat
    while not stopping.wait(1):
        if time.monotonic() - last_heartbeat > 15:
            stopping.set()
            with lock:
                processes = [(entry[0], entry[2]) for entry in running.values() if entry[0] is not None]
            for proc, descendants in processes:
                terminate_process(proc, descendants)
            return

def main():
    global ROOT, WORKSPACE_ID, last_heartbeat
    options = sys.argv[1:]
    if len(options) < 2 or options[0] != "--root":
        raise SystemExit("usage: runner.py --root ABSOLUTE_PATH [--workspace-id HASH] [--runtime-path /opt/adelic-runtimes/node/bin]")
    raw_root = Path(options[1])
    runtime_path = ""
    supplied_workspace_id = None
    index = 2
    while index < len(options):
        if options[index] == "--runtime-path" and index + 1 < len(options) and options[index + 1] == "/opt/adelic-runtimes/node/bin":
            runtime_path = "/opt/adelic-runtimes/node/bin:"
            index += 2
        elif options[index] == "--workspace-id" and index + 1 < len(options) and len(options[index + 1]) == 64 and all(char in "0123456789abcdef" for char in options[index + 1]):
            supplied_workspace_id = options[index + 1]
            index += 2
        else:
            raise SystemExit("invalid runner option")
    if not raw_root.is_absolute():
        raise SystemExit("root must be absolute")
    ROOT = raw_root.resolve(strict=True)
    root_info = ROOT.stat()
    WORKSPACE_ID = supplied_workspace_id or hashlib.sha256(
        os.fsencode(str(ROOT) + "\0" + str(root_info.st_dev) + ":" + str(root_info.st_ino))
    ).hexdigest()
    if not ROOT.is_dir():
        raise SystemExit("root must be a directory")
    if platform.system() != "Linux":
        raise SystemExit("remote runner supports Linux only")
    if os.geteuid() == 0:
        raise SystemExit("remote runner refuses to run as root")
    temp = tempfile.mkdtemp(prefix="adelic-remote-")
    for name in ("HOME", "TMPDIR", "CODEX_HOME", "KIRO_HOME"):
        path = os.path.join(temp, name.lower())
        os.makedirs(path, mode=0o700, exist_ok=True)
        os.environ[name] = path
    os.environ.clear()
    os.environ.update({"PATH": runtime_path + "/usr/local/bin:/usr/bin:/bin", "HOME": os.path.join(temp, "home"), "TMPDIR": os.path.join(temp, "tmp"), "CODEX_HOME": os.path.join(temp, "codex_home"), "KIRO_HOME": os.path.join(temp, "kiro_home"), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_OPTIONAL_LOCKS": "0"})
    for key in ("HOME", "TMPDIR", "CODEX_HOME", "KIRO_HOME"):
        os.makedirs(os.environ[key], mode=0o700, exist_ok=True)
    last_heartbeat = time.monotonic()
    threading.Thread(target=watchdog, daemon=True).start()
    while not stopping.is_set():
        raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not raw:
            break
        if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
            send({"id": None, "ok": False, "error": "request frame exceeds limit"})
            break
        try:
            request = json.loads(raw)
        except (ValueError, UnicodeError):
            send({"id": None, "ok": False, "error": "invalid JSON frame"})
            break
        if not isinstance(request, dict):
            send({"id": None, "ok": False, "error": "request must be an object"})
            break
        if request.get("method") == "heartbeat":
            if set(request) != {"method"}:
                send({"id": None, "ok": False, "error": "heartbeat request does not match the supported schema"})
                break
            last_heartbeat = time.monotonic()
            continue
        if request.get("method") == "cancel":
            if set(request) != {"method", "id"}:
                send({"id": None, "ok": False, "error": "cancel request does not match the supported schema"})
                break
            request_id = request.get("id")
            if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                send({"id": None, "ok": False, "error": "cancel id must be a string or integer"})
                break
            entry = running.get(request_id)
            if entry:
                entry[1].set()
            continue
        request_id = request.get("id")
        if request.get("method") in ("info", "call") and isinstance(request_id, (str, int)) and not isinstance(request_id, bool) and len(str(request_id)) <= 128:
            with lock:
                if request_id in running:
                    send({"id": request_id, "ok": False, "error": "duplicate request id"})
                    continue
                running[request_id] = (None, threading.Event(), set())
        threading.Thread(target=process_request, args=(request,), daemon=True).start()
    stopping.set()
    with lock:
        processes = [(entry[0], entry[2]) for entry in running.values() if entry[0] is not None]
    for proc, descendants in processes:
        terminate_process(proc, descendants)
    shutil.rmtree(temp, ignore_errors=True)

if __name__ == "__main__":
    main()
`;
