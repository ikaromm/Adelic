import { startServer, type RunningServer } from './runtime.js';

type ParentMessage =
  | { type: 'ready'; url: string; port: number; nodeVersion: string }
  | { type: 'error'; message: string }
  // After "Atualizar Adelic" (docs/specs/self-update.md): the main process stops this
  // backend as usual and relaunches the (replaced) AppImage.
  | { type: 'relaunch' };

interface UtilityParentPort {
  postMessage(message: ParentMessage): void;
  on(event: 'message' | 'disconnect', listener: (event: unknown) => void): this;
}

const parentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
let runtime: RunningServer | undefined;
let stopping: Promise<void> | undefined;

function send(message: ParentMessage) {
  try {
    parentPort?.postMessage(message);
  } catch {
    /* Parent shutdown already owns process cleanup. */
  }
}

function shutdown() {
  return (stopping ??= (async () => {
    try {
      await runtime?.close();
    } catch (error) {
      console.error('Falha ao encerrar runtime Adelic:', error);
    }
    process.exit(0);
  })());
}

function eventData(event: unknown): unknown {
  return event && typeof event === 'object' && 'data' in event ? (event as { data: unknown }).data : event;
}

parentPort?.on('message', (event) => {
  const message = eventData(event);
  if (
    message &&
    typeof message === 'object' &&
    'type' in message &&
    (message as { type?: unknown }).type === 'shutdown'
  )
    void shutdown();
});
parentPort?.on('disconnect', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});

async function main() {
  if (!parentPort) throw new Error('Entrada desktop precisa ser iniciada pelo processo utilitário do Electron.');
  runtime = await startServer({
    port: 0,
    webDir: process.env.ADELIC_WEB_DIR,
    dataDir: process.env.ADELIC_DATA_DIR,
    development: false,
    restart: () => send({ type: 'relaunch' }),
  });
  send({ type: 'ready', url: runtime.url, port: runtime.port, nodeVersion: process.versions.node });
}

void main().catch((error) => {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
