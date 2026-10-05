import { resolve } from 'node:path';
import { seedAdelicProject, startServer } from './runtime.js';

async function main() {
  const cwd = resolve(process.cwd());
  const development = process.env.NODE_ENV !== 'production';
  const webDir = process.env.ADELIC_WEB_DIR ?? resolve(cwd, 'dist');
  const server = await startServer({ port: 4317, webDir, dataDir: process.env.ADELIC_DATA_DIR, development, seedProject: await seedAdelicProject(cwd) });
  console.log(`Adelic disponível em ${server.url}`);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= server.close().then(() => { process.exitCode = 0; }, error => { console.error('Falha ao encerrar Adelic:', error); process.exitCode = 1; });
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}

void main().catch(error => { console.error('Falha ao iniciar Adelic:', error); process.exitCode = 1; });
