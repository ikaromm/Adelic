// Table-driven regression suite for the safe-command classifier (docs/specs/safe-command-approvals.md).
// Every case runs against a real temporary project: files, a fake git repository with clean
// configuration, symlinks and a fake Graphify installation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, symlink, rm, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import { classifyApproval, type ApprovalInput } from '../server/approval-policy';
import { parseShell } from '../server/shell-grammar';
import { gitConfigSafety, inspectGitConfig } from '../server/git-safety';

let base: string, root: string, home: string, graphs: string, graph: string, graphifyBin: string, fakeGraphify: string;
let outsideGraph: string;
const oldPath = process.env.PATH;

beforeAll(async () => {
  const temp = path.join(process.cwd(), '.adelic/test-tmp');
  await mkdir(temp, { recursive: true });
  base = await realpath(await mkdtemp(path.join(temp, 'safe-commands-')));
  root = path.join(base, 'project');
  home = path.join(base, 'home');
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await mkdir(path.join(home, '.config', 'git'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{\n  "name": "demo",\n  "version": "1.2.3"\n}\n');
  await writeFile(path.join(root, 'README.md'), 'linha 1\nlinha 2\nlinha 3\n');
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const createBackend = 1;\n');
  await writeFile(path.join(root, 'src', 'nested', 'deep.ts'), 'export {};\n');
  await writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await symlink('/etc/passwd', path.join(root, 'escape'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: root },
  );
  // A clean global layer, so the developer's real ~/.gitconfig never decides a case.
  await writeFile(path.join(home, '.gitconfig'), '[user]\n  name = Test\n[alias]\n  st = status\n');
  graphs = path.join(base, 'data', 'graphs', 'abc123');
  graph = path.join(graphs, 'graphify-out', 'graph.json');
  await mkdir(path.dirname(graph), { recursive: true });
  await writeFile(graph, '{"nodes":[],"links":[]}');
  outsideGraph = path.join(base, 'other', 'graph.json');
  await mkdir(path.dirname(outsideGraph), { recursive: true });
  await writeFile(outsideGraph, '{}');
  graphifyBin = path.join(base, 'tools', 'graphify');
  fakeGraphify = path.join(base, 'fake', 'graphify');
  for (const bin of [graphifyBin, fakeGraphify]) {
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
  }
  await symlink(graphifyBin, path.join(base, 'tools', 'graphify-link'));
  process.env.PATH = `/usr/bin:/bin`;
});
afterAll(async () => {
  process.env.PATH = oldPath;
  await rm(base, { recursive: true, force: true });
});

const gitConfig = () => ({ home, systemConfig: path.join(base, 'no-system-gitconfig'), env: {} });
function input(command: string, extra: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    tools: true,
    kind: 'command',
    command,
    cwd: root,
    workspace: root,
    sandbox: 'workspace-write',
    gitConfig: gitConfig(),
    graphify: { binary: graphifyBin, graphsRoot: graphs },
    ...extra,
  };
}
const decide = async (command: string, extra: Partial<ApprovalInput> = {}) =>
  (await classifyApproval(input(command, extra))).decision;
const P = (name: string) => `{{${name}}}`;
/** Placeholders resolved after the fixture exists: {{graph}}, {{bin}}, {{fake}}, {{outside}}, {{link}}. */
const expand = (command: string) =>
  command
    .replaceAll(P('graph'), graph)
    .replaceAll(P('bin'), graphifyBin)
    .replaceAll(P('fake'), fakeGraphify)
    .replaceAll(P('outside'), outsideGraph)
    .replaceAll(P('link'), path.join(base, 'tools', 'graphify-link'));

// The user's real requests (Codex wraps them in a trusted non-login bash).
const REAL = [
  `/usr/bin/bash -c "grep -n '\\"version\\"' package.json; git status --short --branch; git describe --tags --long --always"`,
  `/usr/bin/bash -c 'git branch --show-current && git status --short && git branch --list && git log -1 --oneline --decorate'`,
  `/usr/bin/bash -c "cat package.json | sed -n '1,45p'; git tag --sort=-version:refname | head -8; git show-ref --tags | tail -5"`,
  `'{{bin}}' query 'createBackend' --graph '{{graph}}' --budget 800`,
];

const AUTO: string[] = [
  ...REAL,
  'pwd',
  'pwd; id; whoami',
  'uname -a && uptime',
  'ls',
  'ls -la src',
  'ls -R src',
  'cat package.json',
  'cat README.md package.json',
  'head -5 README.md',
  'head -n 2 README.md',
  'tail -n1 README.md',
  'wc -l README.md src/index.ts',
  'cat README.md | wc -l',
  'cat README.md | sort | uniq -c | sort -rn | head -3',
  'cat README.md | grep linha | cut -d " " -f 2',
  'cat README.md | tr a-z A-Z',
  "sed -n '2p' README.md",
  "sed -n '1,2p' README.md",
  "sed -n '$p' README.md",
  "sed -n '2,$p' README.md",
  'cat README.md | sed -n 1p',
  'grep -n linha README.md',
  'grep -rn createBackend src',
  "grep -rn --include='*.ts' createBackend src",
  'grep -c linha README.md 2>/dev/null',
  'grep -i LINHA README.md 2>&1',
  'grep -nE "linha [0-9]" README.md >/dev/null 2>&1',
  'grep -n linha README.md > /dev/null',
  'grep -rn createBackend --exclude-dir=.git .',
  'rg --no-config -n createBackend src',
  'rg --no-config -n createBackend',
  "rg --no-config -n -g '!*.md' createBackend .",
  'rg --no-config -l export src/index.ts src/nested',
  'find src -name "*.ts"',
  'find . -maxdepth 2 -type f -name README.md',
  'find src -type d -not -name nested -print',
  'basename src/index.ts',
  'dirname src/index.ts',
  'realpath src/index.ts',
  'stat README.md',
  'file README.md',
  'du -sh src',
  'du -h -d 1 src',
  'echo hello world',
  'printf "%s\\n" ok',
  'true && echo done',
  'date +%Y-%m-%d',
  'which git',
  'jq .name package.json',
  "jq -r '.version' package.json",
  'cat package.json | jq .version',
  'jq -n 1',
  'git --version',
  'git status',
  'git status --short --branch',
  'git status --porcelain=v1 -uno',
  'git log --oneline -5',
  'git log -n 3 --format=%h%x20%s',
  'git log -1 --oneline --decorate',
  'git log --oneline main -- README.md',
  'git show --stat HEAD',
  'git show HEAD:package.json',
  'git diff',
  'git diff --stat HEAD~1',
  'git diff --cached --name-only',
  'git branch --show-current',
  'git branch --list',
  'git branch -a',
  'git describe --tags --always',
  'git rev-parse --show-toplevel',
  'git rev-parse --abbrev-ref HEAD',
  'git tag --list',
  'git tag -l "v1*"',
  'git tag --sort=-version:refname',
  'git show-ref --tags',
  'git ls-files',
  'git ls-files src',
  'git remote -v',
  'git config --get user.name',
  'git --no-pager log -1',
  'git -C src status',
  'git blame -L 1,2 README.md',
  '/usr/bin/git status',
  'git status 2>/dev/null || echo not-a-repo',
  'pactl list sources; wpctl status',
  "{{bin}} query 'createBackend' --graph {{graph}} --budget 800",
  '{{link}} query term --graph {{graph}} --budget 1',
  "{{bin}} query 'a b c' --graph {{graph}} --budget 5000",
  `/usr/bin/bash -c "{{bin}} query x --graph {{graph}} --budget 800 | head -20"`,
];

const PENDING: string[] = [
  // Destructive and writing commands.
  'rm README.md',
  'rm -rf src',
  'mv README.md x',
  'cp README.md x',
  'mkdir x',
  'touch x',
  'chmod 777 README.md',
  'chown root README.md',
  'ln -s README.md x',
  'cat README.md | tee x',
  'dd if=README.md of=x',
  'truncate -s 0 README.md',
  // Redirections other than the /dev/null ones.
  'cat README.md > copy',
  'cat README.md >copy',
  'cat README.md >> copy',
  'echo x 2> err.log',
  'cat README.md 1>copy',
  'cat < README.md',
  'cat README.md >| copy',
  'cat README.md &> /dev/null',
  'cat README.md 3>/dev/null',
  'cat README.md 2>&3',
  'cat README.md > /dev/null/../../tmp/x',
  'cat README.md >/dev/nullx',
  // Mutating or risky git.
  'git commit -m x',
  'git push',
  'git pull',
  'git fetch',
  'git checkout main',
  'git reset --hard',
  'git clean -fd',
  'git stash',
  'git merge x',
  'git rebase main',
  'git apply x.patch',
  'git worktree add x',
  'git submodule update',
  'git gc',
  'git config user.name x',
  'git config --get credential.helper',
  'git config --get remote.origin.token',
  'git -c core.pager=cat log',
  'git -c core.fsmonitor=/tmp/x status',
  'git --exec-path=/tmp log',
  'git --git-dir=/tmp/x status',
  'git --work-tree=/ status',
  'git -C / status',
  'git -C .. status',
  'git log --ext-diff -p',
  'git show --textconv HEAD',
  'git diff --ext-diff',
  'git log --output=x',
  'git branch newbranch',
  'git tag v9',
  'git tag -d v1',
  'git branch -D main',
  'git log --format=%G?',
  'git log -- "*.env"',
  'git show HEAD:.env',
  'git st',
  // find / sed / sort / xargs.
  'find . -exec rm {} ;',
  'find . -delete',
  'find . -execdir ls',
  'find . -fprint x',
  'find / -name x',
  'find .. -name x',
  "sed -i 's/a/b/' README.md",
  "sed 's/a/b/' README.md",
  "sed -n 'w out' README.md",
  "sed -n '1e id' README.md",
  "sed -n '1r /etc/passwd' README.md",
  'sort -o out README.md',
  'sort --compress-program=sh README.md',
  'cat README.md | xargs rm',
  'uniq README.md out',
  // Environment and secrets.
  'env',
  'printenv',
  'env FOO=1 ls',
  'FOO=bar ls',
  'cat .env',
  'cat ~/.ssh/id_ed25519',
  'cat /etc/passwd',
  'cat escape',
  'cat src/../../outside',
  'ls ..',
  'grep -r x /etc',
  'grep -R createBackend src',
  'grep -r createBackend .',
  'grep -f patterns README.md',
  'grep --exclude-from=x y README.md',
  'jq -f prog.jq package.json',
  'jq --rawfile x /etc/passwd . package.json',
  'jq env package.json',
  'jq $ENV package.json',
  'jq \'import "x" as y; .\' package.json',
  'rg createBackend src',
  'rg --no-config --pre cat x src',
  'rg --no-config -L x src',
  'rg --no-config --hidden x .',
  "rg --no-config -g '.env' x .",
  'stat /etc/shadow',
  'realpath /etc',
  'file -m x README.md',
  'du -sh /',
  'which -a git',
  'date -s 2020-01-01',
  'date --set=now',
  'echo -e "\\x41"',
  // stdin readers outside a pipeline.
  'wc -l',
  'tr a b',
  'head',
  // Shells, interpreters, network, package managers.
  'bash -lc ls',
  'sh -c ls',
  'zsh -c ls',
  'eval ls',
  'source x',
  '. x',
  'exec ls',
  'sudo ls',
  'curl https://example.com',
  'wget https://example.com',
  'npm test',
  'npm --version',
  'npx tsc',
  'node script.js',
  'python3 script.py',
  'python3 -c "print(1)"',
  // Expansions and syntax.
  'echo $(id)',
  'echo `id`',
  'echo $HOME',
  'echo "$HOME"',
  'cat *.md',
  'cat README.m?',
  'cat {a,b}',
  'cat ~/x',
  'ls; rm -rf /',
  'ls && rm -rf /',
  'ls || rm -rf /',
  'ls | sh',
  'ls & rm x',
  'ls &',
  '(ls)',
  '{ ls; }',
  'ls\nrm x',
  'ls\r rm x',
  'cat <<EOF',
  'ls ;',
  '; ls',
  'ls ;; ls',
  'ls | | wc',
  'ls # comment',
  '!ls',
  'echo "unterminated',
  'ls\u00a0-la',
  'ls\u2028rm x',
  'ls\u200b',
  'ls \uff1b rm x',
  'cat README.md\u037erm x',
  // Bounds.
  `echo ${'a'.repeat(4001)}`,
  Array.from({ length: 13 }, () => 'pwd').join('; '),
  // Graphify outside the exact suggested shape.
  '{{fake}} query x --graph {{graph}} --budget 800',
  '{{bin}} query x --graph {{outside}} --budget 800',
  '{{bin}} query x --graph {{graph}} --budget 800 --dfs',
  '{{bin}} query x --graph {{graph}} --budget 0',
  '{{bin}} query x --graph {{graph}} --budget 5001',
  '{{bin}} query x --graph {{graph}}',
  '{{bin}} explain x --graph {{graph}}',
  '{{bin}} add https://example.com',
  '{{bin}} query --graph {{graph}} --budget 800',
  // Unknown commands.
  'kill 1',
  'systemctl stop x',
  'unknowncmd',
];

describe('safe-command classifier table', () => {
  for (const raw of AUTO)
    it(`auto: ${raw.slice(0, 90)}`, async () => {
      const result = await classifyApproval(input(expand(raw), { trustedNonLoginShell: true }));
      expect(result, result.reason).toMatchObject({ decision: 'auto' });
    });
  for (const raw of PENDING)
    it(`pending: ${JSON.stringify(raw).slice(0, 90)}`, async () => {
      const result = await classifyApproval(input(expand(raw), { trustedNonLoginShell: true }));
      expect(result.decision, result.reason).toBe('pending');
    });
  it('has a broad table', () => {
    expect(AUTO.length + PENDING.length).toBeGreaterThanOrEqual(120);
  });
});

describe('git configuration rule', () => {
  const RISKY = [
    '[core]\n\tfsmonitor = /tmp/evil',
    '[core]\n\tpager = less',
    '[core]\n\tsshCommand = ssh -i x',
    '[core]\n\thooksPath = /tmp/hooks',
    '[diff]\n\texternal = /tmp/difftool',
    '[diff "img"]\n\ttextconv = exiftool',
    '[diff "img"]\n\tcommand = /tmp/x',
    '[filter "lfs"]\n\tclean = git-lfs clean',
    '[include]\n\tpath = other.cfg',
    '[includeIf "gitdir:~/x/"]\n\tpath = other.cfg',
    '[pager]\n\tlog = less',
    '[log]\n\tshowSignature = true',
    '[core]\n\tFSMonitor = /tmp/evil',
    '[CORE]\n\tfsmonitor = x',
    '[core]\n\tfsmonitor = x \\\n\t  continued',
    '[core] fsmonitor = /tmp/evil',
    'garbage without section',
  ];
  for (const config of RISKY)
    it(`refuses ${JSON.stringify(config).slice(0, 60)}`, async () => {
      expect(inspectGitConfig(config, 'teste').safe).toBe(false);
    });
  it('accepts ordinary configuration, including aliases and remote URLs', () => {
    expect(
      inspectGitConfig(
        '# comment\n[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:x/y.git\n[alias]\n\tst = status\n[branch "main"]\n\tremote = origin\n',
        'teste',
      ),
    ).toEqual({ safe: true });
    expect(inspectGitConfig('[remote "o"]\n\turl = https://user:pw@example.com/x', 'teste')).toEqual({
      safe: true,
      credentialUrl: true,
    });
  });

  it('applies the repository, global and system layers', async () => {
    const repo = path.join(base, 'risky-repo');
    await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const repoInput = (extra: Partial<ApprovalInput> = {}) =>
      input('git status --short', { cwd: repo, workspace: repo, ...extra });
    expect((await classifyApproval(repoInput())).decision).toBe('auto');
    execFileSync('git', ['config', 'core.fsmonitor', '/tmp/evil'], { cwd: repo });
    const risky = await classifyApproval(repoInput());
    expect(risky.decision).toBe('pending');
    expect(risky.reason).toMatch(/pode executar programas/);
    execFileSync('git', ['config', '--unset', 'core.fsmonitor'], { cwd: repo });
    expect((await classifyApproval(repoInput())).decision).toBe('auto');
    // Global (~/.gitconfig and XDG) and system layers.
    const altHome = path.join(base, 'risky-home');
    await mkdir(path.join(altHome, '.config', 'git'), { recursive: true });
    await writeFile(path.join(altHome, '.config', 'git', 'config'), '[diff]\n\texternal = /tmp/x\n');
    expect((await classifyApproval(repoInput({ gitConfig: { home: altHome, env: {} } }))).decision).toBe('pending');
    const system = path.join(base, 'system-gitconfig');
    await writeFile(system, '[core]\n\tpager = less\n');
    expect((await classifyApproval(repoInput({ gitConfig: { home, systemConfig: system, env: {} } }))).decision).toBe(
      'pending',
    );
    // Environment variables that add configuration or run programs.
    for (const env of [{ GIT_CONFIG_COUNT: '1' }, { GIT_EXTERNAL_DIFF: '/tmp/x' }, { GIT_DIR: '/tmp' }])
      expect((await classifyApproval(repoInput({ gitConfig: { ...gitConfig(), env } }))).decision).toBe('pending');
    // Hooks that read-only commands can trigger, submodules and info/attributes.
    await writeFile(path.join(repo, '.git', 'hooks', 'post-index-change'), '#!/bin/sh\n');
    expect((await classifyApproval(repoInput())).decision).toBe('pending');
    await rm(path.join(repo, '.git', 'hooks', 'post-index-change'));
    await writeFile(path.join(repo, '.gitmodules'), '');
    expect((await classifyApproval(repoInput())).decision).toBe('pending');
    await rm(path.join(repo, '.gitmodules'));
    await mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    await writeFile(path.join(repo, '.git', 'info', 'attributes'), '* diff=x\n');
    expect((await classifyApproval(repoInput())).decision).toBe('pending');
  });

  it('asks when the repository is above the project or missing, and when URLs carry credentials', async () => {
    const plain = path.join(base, 'no-repo');
    await mkdir(plain, { recursive: true });
    expect((await gitConfigSafety(plain, plain, gitConfig())).safe).toBe(false);
    // `src` is inside the repository root but is the project: git would read ../.git.
    expect(
      (await classifyApproval(input('git status', { cwd: path.join(root, 'src'), workspace: path.join(root, 'src') })))
        .decision,
    ).toBe('pending');
    const repo = path.join(base, 'cred-repo');
    await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://user:synthetic@example.invalid/x.git'], { cwd: repo });
    expect((await classifyApproval(input('git remote -v', { cwd: repo, workspace: repo }))).decision).toBe('pending');
    expect((await classifyApproval(input('git status', { cwd: repo, workspace: repo }))).decision).toBe('auto');
  });

  it('follows a linked worktree to its common git dir', async () => {
    const main = path.join(base, 'main-repo');
    await mkdir(main, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'],
      { cwd: main },
    );
    const wt = path.join(base, 'linked-wt');
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'feature'], { cwd: main });
    const run = () => classifyApproval(input('git log -1 --oneline', { cwd: wt, workspace: wt }));
    expect((await run()).decision).toBe('auto');
    execFileSync('git', ['config', 'diff.external', '/tmp/x'], { cwd: main });
    expect((await run()).decision).toBe('pending');
  });
});

describe('restricted shell grammar', () => {
  it('splits lists and pipelines and keeps empty quoted words', () => {
    const parsed = parseShell("a 'x y' '' && b | c; d || e");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.script.commands.map((c) => c.argv)).toEqual([['a', 'x y', ''], ['b'], ['c'], ['d'], ['e']]);
    expect(parsed.script.commands.map((c) => c.pipedStdin)).toEqual([false, false, true, false, false]);
  });
  it('recognizes only the /dev/null redirections', () => {
    for (const [text, redirects] of [
      ['a 2>/dev/null', ['2>/dev/null']],
      ['a 2> /dev/null', ['2>/dev/null']],
      ['a >/dev/null 2>&1', ['>/dev/null', '2>&1']],
      ['a 1>/dev/null', ['>/dev/null']],
    ] as const) {
      const parsed = parseShell(text);
      expect(parsed.ok && parsed.script.commands[0]!.redirects).toEqual(redirects);
    }
    // A quoted "2" is an argument, not a file descriptor.
    expect(
      parseShell("a '2'>/dev/null").ok &&
        (parseShell("a '2'>/dev/null") as never as { script: { commands: { argv: string[] }[] } }).script.commands[0]!
          .argv,
    ).toEqual(['a', '2']);
    for (const text of ['a 2>', 'a > ', 'a 2>&1x', 'a 1>&2', 'a > /dev/null2', 'a >"/dev/null"x'])
      expect(parseShell(text).ok).toBe(false);
  });
  it('rejects portable-only hazards when the shell is unknown', () => {
    for (const text of ["echo 'a\\b'", 'echo "\\`"', 'echo a^b', 'echo a#b', 'git log HEAD~1'])
      expect(parseShell(text, { portable: true }).ok).toBe(false);
    expect(parseShell('git log HEAD~1').ok).toBe(true);
    expect(parseShell('echo a#b').ok).toBe(true);
  });
});

describe('modes, sandbox and scope invariants', () => {
  it('manual mode, missing tools and non-command kinds never auto-approve', async () => {
    expect(await decide('pwd', { mode: 'manual' })).toBe('pending');
    expect(await decide('git status', { mode: 'manual' })).toBe('pending');
    expect(await decide('pwd', { tools: false })).toBe('deny');
    expect(await decide('pwd', { kind: 'file' })).toBe('pending');
    expect(await decide('pwd', { networkApprovalContext: {} })).toBe('pending');
  });
  it('keeps auto-approving reads in a read-only sandbox', async () => {
    expect(await decide('git status; cat README.md', { sandbox: 'read-only' })).toBe('auto');
  });
  it('without trusted Graphify paths, graphify asks like any program', async () => {
    expect(await decide(expand('{{bin}} query x --graph {{graph}} --budget 800'), { graphify: undefined })).toBe(
      'pending',
    );
  });
  it('Kiro-style portable parsing never unwraps bash and keeps the same allowlist', async () => {
    const kiro = { portableShell: true, trustedNonLoginShell: false };
    expect(await decide('ls -la', kiro)).toBe('auto');
    expect(await decide('git status --short && git log -1 --oneline', kiro)).toBe('auto');
    expect(await decide('bash -c "ls"', kiro)).toBe('pending');
    expect(await decide('/usr/bin/bash -c ls', kiro)).toBe('pending');
    expect(await decide('rm x', kiro)).toBe('pending');
  });
  it('a symlinked project directory that escapes the workspace asks', async () => {
    await symlink('/etc', path.join(root, 'etc-link'));
    try {
      expect(await decide('ls etc-link')).toBe('pending');
      expect(await decide('find etc-link -name passwd')).toBe('pending');
      expect(await decide('grep -rn root etc-link')).toBe('pending');
    } finally {
      await rm(path.join(root, 'etc-link'));
    }
  });
  it('recursive searches ask when the tree contains a secret-named file', async () => {
    await writeFile(path.join(root, 'src', 'nested', 'credentials.json'), '{}');
    try {
      expect(await decide('grep -rn createBackend src')).toBe('pending');
      expect(await decide('rg --no-config createBackend src')).toBe('pending');
      expect(await decide('cat src/index.ts')).toBe('auto');
    } finally {
      await rm(path.join(root, 'src', 'nested', 'credentials.json'));
    }
  });
  it('rg asks when an ignore file un-hides hidden entries', async () => {
    await writeFile(path.join(root, 'src', '.secretish'), 'x');
    expect(await decide('rg --no-config createBackend src')).toBe('auto');
    await writeFile(path.join(root, 'src', '.ignore'), '!.secretish\n');
    try {
      expect(await decide('rg --no-config createBackend src')).toBe('pending');
    } finally {
      await rm(path.join(root, 'src', '.ignore'));
      await rm(path.join(root, 'src', '.secretish'));
    }
  });
  it('a compound script reports which element needs confirmation', async () => {
    const result = await classifyApproval(input('git status; rm -rf src'));
    expect(result.decision).toBe('pending');
    expect(result.reason).toMatch(/\[rm\]/);
  });
});
