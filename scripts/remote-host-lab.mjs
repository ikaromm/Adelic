#!/usr/bin/env node
// Isolated SSH fixture and transport smoke test. Never use a personal SSH key here.
// Usage: npx tsx scripts/remote-host-lab.mjs prepare /tmp/adelic-ssh-lab
//        npx tsx scripts/remote-host-lab.mjs verify /tmp/adelic-ssh-lab --ack-home-install
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [action = 'help', input, ...flags] = process.argv.slice(2);
const usage = () => {
  console.log('Prepare: npx tsx scripts/remote-host-lab.mjs prepare /tmp/adelic-ssh-lab');
  console.log('Build:   docker build --progress=plain -t adelic-ssh-lab:0.5.1 /tmp/adelic-ssh-lab');
  console.log(
    'Start:   docker run -d --name adelic-ssh-lab --cap-add SYS_PTRACE --security-opt seccomp=unconfined -p 127.0.0.1:4422:22 adelic-ssh-lab:0.5.1',
  );
  console.log('Verify:  npx tsx scripts/remote-host-lab.mjs verify /tmp/adelic-ssh-lab --ack-home-install');
};

const ensureKeypair = async (dir) => {
  const privateKey = join(dir, 'id_ed25519');
  const publicKey = `${privateKey}.pub`;
  const hasPrivate = await access(privateKey).then(
    () => true,
    () => false,
  );
  const hasPublic = await access(publicKey).then(
    () => true,
    () => false,
  );
  if (hasPrivate !== hasPublic)
    throw new Error(`Incomplete test keypair in ${dir}; remove both fixture key files and prepare again.`);
  if (!hasPrivate) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey], { stdio: 'inherit' });
  }
  await chmod(privateKey, 0o600);
  await chmod(publicKey, 0o644);
};

const prepare = async (dir) => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await ensureKeypair(dir);
  const port = Number(process.env.ADELIC_SSH_LAB_PORT ?? 4422);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('ADELIC_SSH_LAB_PORT must be a valid TCP port.');
  const runnerPath = process.env.ADELIC_SSH_LAB_RUNNER ?? '/home/shared/.cache/adelic-runner/0.5.1/runner.py';
  if (!runnerPath.startsWith('/') || runnerPath.includes('\0'))
    throw new Error('ADELIC_SSH_LAB_RUNNER must be absolute.');
  const localCommandMarker = join(dir, 'local-command-ran');

  await writeFile(
    join(dir, 'Dockerfile'),
    `FROM alpine:3.22
RUN apk add --no-cache openssh python3 git bash procps \\
  && adduser -D -s /bin/bash shared \\
  && passwd -u shared \\
  && ssh-keygen -A \\
  && mkdir -p /home/shared/.ssh /home/shared/.codex /workspace \\
  && chown shared:shared /workspace /home/shared/.ssh /home/shared/.codex \\
  && chmod 700 /home/shared/.ssh /home/shared/.codex \\
  && printf '# Deliberate fixture: the runner must use a temporary HOME.\\n' > /home/shared/.codex/config.toml \\
  && git -C /workspace init -q \\
  && git -C /workspace config user.name 'Adelic SSH Lab' \\
  && git -C /workspace config user.email 'adelic-lab@example.invalid' \\
  && printf 'SSH runner fixture\\n' > /workspace/README.md \\
  && git -C /workspace add README.md \\
  && git -C /workspace commit -qm 'create SSH fixture'
COPY id_ed25519.pub /home/shared/.ssh/authorized_keys
RUN chown shared:shared /home/shared/.ssh/authorized_keys \\
  && chmod 600 /home/shared/.ssh/authorized_keys \\
  && printf 'PasswordAuthentication no\\nPermitRootLogin no\\nAllowUsers shared\\nAllowAgentForwarding yes\\nAllowTcpForwarding yes\\nX11Forwarding yes\\nAcceptEnv *TOKEN* CODEX* KIRO*\\n' > /etc/ssh/sshd_config.d/adelic.conf
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`,
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, '.dockerignore'),
    ['id_ed25519', 'ssh_config', 'app-data', 'client-data', 'local-command-ran', ''].join('\n'),
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, 'ssh_config'),
    `Host shared-lab
  HostName 127.0.0.1
  User shared
  Port ${port}
  IdentityFile ${join(dir, 'id_ed25519')}
  IdentitiesOnly yes
  BatchMode yes
  ForwardAgent yes
  ForwardX11 yes
  RemoteForward 4499 127.0.0.1:4317
  ControlMaster yes
  ControlPath ${join(dir, 'shared-control')}
  PermitLocalCommand yes
  LocalCommand touch ${localCommandMarker}
  SendEnv *TOKEN* CODEX* KIRO*
`,
    { mode: 0o600 },
  );
  await mkdir(join(dir, 'app-data'), { recursive: true, mode: 0o700 });
  console.log(`Prepared isolated fixture in ${dir}. The private key is excluded from the Docker build context.`);
  console.log(`Image: adelic-ssh-lab:0.5.1 | SSH alias: shared-lab | loopback port: ${port}`);
  usage();
};

const verify = async (dir) => {
  const ackHomeInstall = flags.includes('--ack-home-install');
  const preinstalled = flags.includes('--preinstalled');
  if (ackHomeInstall === preinstalled) {
    throw new Error(
      'Choose exactly one: --ack-home-install for a home install, or --preinstalled for a manually installed runner.',
    );
  }
  const port = Number(process.env.ADELIC_SSH_LAB_PORT ?? 4422);
  const runnerPath = process.env.ADELIC_SSH_LAB_RUNNER ?? '/home/shared/.cache/adelic-runner/0.5.1/runner.py';
  const configFile = process.env.ADELIC_SSH_CONFIG ?? join(dir, 'ssh_config');
  const dataDir = join(dir, 'app-data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const { RemoteHostService } = await import('../server/remote/transport.ts');
  const service = RemoteHostService(dataDir, { configFile });
  const canaryName = 'ADELIC_LAB_TOKEN';
  const oldCanary = process.env[canaryName];
  const canary = `discardable-lab-${randomUUID()}`;
  process.env[canaryName] = canary;
  let connection;
  const testFile = `adelic-remote-lab-${randomUUID()}.txt`;

  try {
    const probe = await service.probe('shared-lab', port);
    const host = {
      ...probe,
      id: `lab-${randomUUID()}`,
      name: 'Isolated SSH lab',
      runnerPath,
      createdAt: new Date().toISOString(),
    };
    if (ackHomeInstall) await service.install(host);
    const info = await service.test(host);
    if (info.platform !== 'Linux' || info.root !== '/') throw new Error('Unexpected remote runner platform or root.');
    connection = await service.connect(host, '/workspace');
    const connected = await connection.info();
    if (connected.root !== '/workspace') throw new Error('Runner did not use the selected project directory.');

    const listed = await connection.call('list', { path: '.' }, AbortSignal.timeout(10000));
    if (!listed.entries.some((entry) => entry.name === 'README.md' || (entry.name === '.git' && entry.directory)))
      throw new Error('Remote list did not find the fixture README or initialized Git repository.');

    const identity = await connection.call('exec', { command: ['id', '-u'] }, AbortSignal.timeout(10000));
    if (identity.exitCode !== 0 || identity.stdout.trim() === '0')
      throw new Error('Remote command did not run as the unprivileged SSH user.');

    const envProbe = await connection.call(
      'exec',
      {
        command: [
          'python3',
          '-c',
          'import json,os; names=("ADELIC_LAB_TOKEN","OPENAI_API_KEY","CODEX_API_KEY","KIRO_API_KEY","SSH_AUTH_SOCK"); paths=("HOME","TMPDIR","CODEX_HOME","KIRO_HOME"); print(json.dumps({"credentials":{name:bool(os.environ.get(name)) for name in names},"privateDirs":all((os.stat(os.environ[name]).st_mode & 0o777)==0o700 for name in paths),"sharedCodexConfigVisible":os.path.exists(os.path.join(os.environ["HOME"],".codex","config.toml"))}))',
        ],
      },
      AbortSignal.timeout(10000),
    );
    const environment = JSON.parse(envProbe.stdout);
    if (
      Object.values(environment.credentials).some(Boolean) ||
      !environment.privateDirs ||
      environment.sharedCodexConfigVisible
    ) {
      throw new Error('Remote command environment was not clean and private.');
    }

    const content = `runner check ${randomUUID()}\n`;
    await connection.call('write_file', { path: testFile, content }, AbortSignal.timeout(10000));
    const read = await connection.call('read_file', { path: testFile }, AbortSignal.timeout(10000));
    if (read.content !== content) throw new Error('Remote read did not return the written content.');
    const stat = await connection.call('stat', { path: testFile }, AbortSignal.timeout(10000));
    if (stat.size !== Buffer.byteLength(content)) throw new Error('Remote stat returned the wrong file size.');
    const search = await connection.call('search', { query: content.trim() }, AbortSignal.timeout(10000));
    if (!search.results.some((entry) => entry.path.endsWith(testFile)))
      throw new Error('Remote search did not find the written file.');
    const git = await connection.call('git', { operation: 'status' }, AbortSignal.timeout(10000));
    if (git.exitCode !== 0) throw new Error('Remote git status failed.');
    await connection.call('exec', { command: ['rm', '-f', testFile] }, AbortSignal.timeout(10000));

    const marker = join(dir, 'local-command-ran');
    const controlSocket = join(dir, 'shared-control');
    await access(marker).then(
      () => {
        throw new Error('SSH LocalCommand unexpectedly ran.');
      },
      () => undefined,
    );
    await access(controlSocket).then(
      () => {
        throw new Error('A configured ControlMaster unexpectedly started.');
      },
      () => undefined,
    );
    console.log(
      `PASS: ${info.platform} / Python ${info.python}; list, exec, write, read, stat, search and git; remote uid is unprivileged.`,
    );
    console.log(
      'PASS: runner commands saw no credential canary, OpenAI/Codex/Kiro keys, SSH agent socket or shared ~/.codex config.',
    );
    console.log('PASS: hostile local forwarding and ControlMaster settings did not activate.');
    console.log(`Pinned fingerprint: ${host.fingerprint}`);
  } finally {
    await connection?.close();
    await service.shutdown();
    if (oldCanary === undefined) delete process.env[canaryName];
    else process.env[canaryName] = oldCanary;
  }
};

if (action === 'prepare') {
  if (!input) throw new Error('Pass an absolute fixture directory.');
  const dir = resolve(input);
  if (!input.startsWith('/')) throw new Error('Fixture directory must be absolute.');
  await prepare(dir);
} else if (action === 'verify') {
  if (!input) throw new Error('Pass the prepared fixture directory.');
  await verify(resolve(input));
} else if (action === 'help' || action === '--help') {
  usage();
} else {
  throw new Error(`Unknown action: ${action}`);
}
