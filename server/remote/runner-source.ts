/**
 * Remote, credential-free JSONL tool runner. Keep this as a string so packaged
 * desktop builds do not depend on a loose Python source file.
 */
export const REMOTE_RUNNER_SOURCE = String.raw`#!/usr/bin/env python3
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

MAX_FRAME = 1024 * 1024
MAX_TEXT = 128 * 1024
MAX_OUTPUT = 256 * 1024
MAX_TIMEOUT = 300000
TOOLS = {"exec", "read_file", "write_file", "list", "stat", "search", "git"}
GIT_READ_COMMANDS = {"status", "diff", "log"}
lock = threading.RLock()
running = {}
last_heartbeat = time.monotonic()
stopping = threading.Event()
write_lock = threading.Lock()

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
    validate_keys(args, ("path",), ("path",))
    path = within_root(args.get("path"))
    if not path.is_file():
        raise ValueError("file does not exist")
    with path.open("rb") as stream:
        data = stream.read(MAX_TEXT + 1)
    if len(data) > MAX_TEXT:
        raise ValueError("file exceeds read limit")
    return {"path": str(path), "content": data.decode("utf-8")}

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
    response_bytes = 2
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name != ".git" and (Path(base) / name).resolve().is_relative_to(ROOT)]
        for name in files:
            file_path = Path(base) / name
            try:
                resolved = file_path.resolve(strict=True)
                resolved.relative_to(ROOT)
                if not resolved.is_file() or resolved.stat().st_size > MAX_TEXT:
                    continue
                content = resolved.read_text(encoding="utf-8")
            except (OSError, UnicodeError, ValueError):
                continue
            for number, line in enumerate(content.splitlines(), 1):
                if query in line:
                    match = {"path": str(resolved), "line": number, "text": line[:2000]}
                    response_bytes += len(json.dumps(match, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
                    if response_bytes > 512 * 1024:
                        return {"results": results, "truncated": True}
                    results.append(match)
                    if len(results) >= limit:
                        return {"results": results, "truncated": True}
    return {"results": results, "truncated": False}

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

def execute(tool, args, request_id):
    if not isinstance(args, dict):
        raise ValueError("args must be an object")
    if tool == "read_file": return read_file(args)
    if tool == "write_file": return write_file(args)
    if tool == "list": return list_dir(args)
    if tool == "stat": return stat_path(args)
    if tool == "search": return search(args)
    if tool == "exec":
        validate_keys(args, ("command", "cwd", "timeoutMs", "readOnly"), ("command",))
        if args.get("readOnly") is True:
            raise ValueError("exec cannot guarantee a read-only filesystem")
        return run_process(args.get("command"), cwd_for(args), args.get("timeoutMs", 120000), request_id)
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
            send({"id": request_id, "ok": True, "result": {"protocol": 1, "python": platform.python_version(), "platform": platform.system(), "root": str(ROOT)}})
            return
        if request.get("method") != "call" or request.get("tool") not in TOOLS:
            raise ValueError("unsupported method or tool")
        if set(request) != {"id", "method", "tool", "args"}:
            raise ValueError("call request does not match the supported schema")
        result = execute(request["tool"], request.get("args", {}), request_id)
        send({"id": request_id, "ok": True, "result": result})
    except Exception as exc:
        message = str(exc)[:2000] or type(exc).__name__
        send({"id": request_id, "ok": False, "error": message})
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
    global ROOT, last_heartbeat
    if len(sys.argv) != 3 or sys.argv[1] != "--root":
        raise SystemExit("usage: runner.py --root ABSOLUTE_PATH")
    raw_root = Path(sys.argv[2])
    if not raw_root.is_absolute():
        raise SystemExit("root must be absolute")
    ROOT = raw_root.resolve(strict=True)
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
    os.environ.update({"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": os.path.join(temp, "home"), "TMPDIR": os.path.join(temp, "tmp"), "CODEX_HOME": os.path.join(temp, "codex_home"), "KIRO_HOME": os.path.join(temp, "kiro_home"), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
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
