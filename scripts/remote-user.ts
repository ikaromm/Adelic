// `npm run remote-user -- <set <username>|delete|status|revoke-sessions>`; see docs/specs/remote-access.md.
import { runRemoteUserCli } from '../server/remote-user-cli.js';

process.exitCode = await runRemoteUserCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
process.stdin.destroy();
