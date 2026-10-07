import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, shell, session, utilityProcess, type UtilityProcess } from 'electron';
import { desktopPath } from '../server/providers/discovery.js';
import {
  desktopResources,
  navigationPolicy,
  permissionPolicy,
  resolveDesktopDataDir,
  subframeNavigationAllowed,
} from './policy.js';
import { stopUtilityProcess, type UtilityState } from './utility-lifecycle.js';

type BackendMessage =
  | { type: 'ready'; url: string; port: number; nodeVersion: string }
  | { type: 'error'; message: string }
  | { type: 'relaunch' };
type SmokeResult = {
  ok: boolean;
  forwarded?: boolean;
  domReady?: boolean;
  httpStatus?: number;
  sqliteIntegrity?: boolean;
  error?: string;
};

const isSmoke = process.env.ADELIC_DESKTOP_SMOKE === '1';
const reportPath = process.env.ADELIC_DESKTOP_REPORT;
const defaultDataDir = resolveDesktopDataDir(process.env.ADELIC_DATA_DIR, homedir());
let dataDir = defaultDataDir;
let lockAcquired = false;
let startupConfigError: string | undefined;

try {
  mkdirSync(dataDir, { recursive: true });
  dataDir = realpathSync(dataDir);
  const userDataDir = join(dataDir, '.desktop-profile');
  mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  lockAcquired = app.requestSingleInstanceLock({ dataDir });
} catch {
  startupConfigError = 'Não foi possível preparar a pasta local de dados do Adelic.';
}

let mainWindow: BrowserWindow | null = null;
let backend: UtilityProcess | null = null;
const backendState: UtilityState = { spawned: false, exited: false };
let backendPid: number | null = null;
let backendUrl: string | null = null;
let backendNodeVersion: string | null = null;
let shutdownRequested = false;
let quitAllowed = false;
let requestedExitCode = 0;
let shutdownPromise: Promise<void> | null = null;
let backendStopPromise: Promise<void> | null = null;
let smokeResult: SmokeResult | undefined;

function logLifecycle(message: string) {
  console.info(`[Adelic desktop] ${message}`);
}

function writeReport() {
  if (!reportPath) return;
  const report = {
    url: backendUrl,
    mainPid: process.pid,
    backendPid,
    nodeVersion: backendNodeVersion || process.versions.node,
    ...(isSmoke ? { smoke: smokeResult || { ok: false, error: 'Smoke ainda não terminou.' } } : {}),
  };
  try {
    const target = resolve(reportPath);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch {
    logLifecycle('não foi possível gravar o relatório de diagnóstico');
  }
}

function waitForBackendReady(
  child: UtilityProcess,
  backendEntry: string,
): Promise<Extract<BackendMessage, { type: 'ready' }>> {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('O servidor local demorou para iniciar.')), 60_000);
    const finish = (error?: Error, message?: Extract<BackendMessage, { type: 'ready' }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onFatalError);
      if (error) rejectReady(error);
      else if (message) resolveReady(message);
    };
    const onMessage = (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      const message = raw as BackendMessage;
      if (message.type === 'error') finish(new Error(message.message || 'O servidor local não conseguiu iniciar.'));
      if (message.type === 'ready') finish(undefined, message);
    };
    const onExit = (code: number) => finish(new Error(`O servidor local encerrou durante a inicialização (${code}).`));
    const onFatalError = () =>
      finish(new Error(`O processo do servidor local não conseguiu abrir ${basename(backendEntry)}.`));
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onFatalError);
  });
}

function stopBackend() {
  if (backendStopPromise) return backendStopPromise;
  const child = backend;
  backendStopPromise = (async () => {
    if (!child) return;
    const stopped = await stopUtilityProcess(child, backendState);
    if (!stopped) logLifecycle('backend ainda não confirmou encerramento após o término forçado');
    backend = null;
  })();
  return backendStopPromise;
}

function requestQuit(exitCode = 0) {
  if (exitCode !== 0) requestedExitCode = exitCode;
  shutdownRequested = true;
  if (!shutdownPromise) {
    shutdownPromise = stopBackend().finally(() => {
      writeReport();
      quitAllowed = true;
      app.exit(requestedExitCode);
    });
  }
  return shutdownPromise;
}

/**
 * After "Atualizar Adelic" replaced the AppImage (docs/specs/self-update.md): stop the
 * backend like a normal quit, then start the file at $APPIMAGE again, which is the new one.
 */
function relaunchAfterUpdate() {
  if (shutdownRequested) return;
  logLifecycle('reiniciando após atualização');
  const appImage = process.env.APPIMAGE;
  app.relaunch(appImage ? { execPath: appImage, args: process.argv.slice(1) } : undefined);
  void requestQuit(0);
}

function handleExternalLink(url: string) {
  if (navigationPolicy(url, backendUrl || '') !== 'external') return;
  void shell.openExternal(url).catch(() => logLifecycle('não foi possível abrir link externo'));
}

function installWindowPolicies(window: BrowserWindow) {
  const origin = backendUrl || '';
  window.webContents.setWindowOpenHandler(({ url }) => {
    handleExternalLink(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-frame-navigate', (details) => {
    // The local preview frame may load loopback dev servers only.
    if (!details.isMainFrame) {
      if (!subframeNavigationAllowed(details.url, origin)) details.preventDefault();
      return;
    }
    const policy = navigationPolicy(details.url, origin);
    if (policy === 'internal') return;
    details.preventDefault();
    if (policy === 'external') handleExternalLink(details.url);
  });
  window.webContents.on('will-redirect', (details) => {
    const allowed = details.isMainFrame
      ? navigationPolicy(details.url, origin) === 'internal'
      : subframeNavigationAllowed(details.url, origin);
    if (!allowed) details.preventDefault();
  });
}

function createWindow(iconPath: string) {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 860,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1015',
    darkTheme: true,
    autoHideMenuBar: true,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = window;
  installWindowPolicies(window);
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

async function runSmoke(window: BrowserWindow) {
  const url = backendUrl;
  if (!url) throw new Error('O servidor local não informou seu endereço.');
  const domReady = await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (document.readyState === 'complete' && document.querySelector('#root .app-shell')) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  })()`);
  if (!domReady) throw new Error('A interface do Adelic não terminou de renderizar.');

  const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`A API local respondeu com HTTP ${response.status}.`);
  const bootstrap = (await response.json()) as { projects?: unknown; sessions?: unknown };
  if (!Array.isArray(bootstrap.projects) || !Array.isArray(bootstrap.sessions)) {
    throw new Error('A API local não retornou os dados persistidos esperados.');
  }

  const database = new DatabaseSync(join(dataDir, 'adelic.sqlite'), { readOnly: true });
  try {
    const result = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const integrity = result?.quick_check === 'ok';
    if (!integrity) throw new Error('A verificação do banco SQLite não passou.');
    return { ok: true, domReady: true, httpStatus: response.status, sqliteIntegrity: true } satisfies SmokeResult;
  } finally {
    database.close();
  }
}

async function showStartupFailure(error: Error) {
  shutdownRequested = true;
  mainWindow?.hide();
  await stopBackend();
  logLifecycle('falha durante a inicialização');
  smokeResult = isSmoke ? { ok: false, error: error.message } : undefined;
  writeReport();
  if (!isSmoke && !shutdownPromise) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Não foi possível iniciar o Adelic',
      message: 'O servidor local do Adelic não iniciou.',
      detail: `${error.message}\n\nFeche outra janela do Adelic ou o modo web que esteja usando a mesma pasta de dados e tente novamente.`,
      buttons: ['Fechar'],
      noLink: true,
    });
  }
  await requestQuit(1);
}

async function showBackendExitFailure(code: number) {
  shutdownRequested = true;
  mainWindow?.hide();
  await stopBackend();
  logLifecycle(`backend local encerrou inesperadamente (${code})`);
  smokeResult = isSmoke ? { ok: false, error: 'O servidor local encerrou durante o smoke.' } : undefined;
  writeReport();
  if (!isSmoke && !shutdownPromise) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Servidor local encerrado',
      message: 'O servidor local do Adelic encerrou inesperadamente.',
      buttons: ['Fechar'],
      noLink: true,
    });
  }
  await requestQuit(1);
}

async function startDesktop() {
  if (startupConfigError) throw new Error(startupConfigError);
  if (!lockAcquired) {
    if (isSmoke) {
      smokeResult = { ok: false, forwarded: true, error: 'A chamada foi encaminhada à instância já aberta.' };
      writeReport();
    }
    await requestQuit(0);
    return;
  }

  const resources = desktopResources(app.getAppPath());
  if (!existsSync(resources.backend)) throw new Error('O pacote não contém o backend local.');
  if (!existsSync(join(resources.web, 'index.html'))) throw new Error('O pacote não contém a interface web.');

  const child = utilityProcess.fork(resources.backend, [], {
    serviceName: 'Adelic local backend',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ADELIC_WEB_DIR: resources.web,
      ADELIC_DATA_DIR: dataDir,
      PATH: desktopPath(process.env),
    },
    stdio: 'ignore',
  });
  backend = child;
  child.on('spawn', () => {
    backendState.spawned = true;
    backendPid = child.pid ?? null;
    writeReport();
    if (backendState.stopping) child.kill();
  });
  child.on('exit', (code) => {
    backendState.exited = true;
    if (!shutdownRequested && backendUrl) void showBackendExitFailure(code);
  });
  child.on('message', (raw: unknown) => {
    if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'relaunch' && backendUrl)
      relaunchAfterUpdate();
  });

  const ready = await waitForBackendReady(child, resources.backend);
  if (shutdownRequested) return;
  const parsed = new URL(ready.url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('O servidor local informou um endereço que não é loopback.');
  }
  backendUrl = ready.url;
  backendNodeVersion = ready.nodeVersion || process.versions.node;
  writeReport();

  // Only notifications and the microphone (audio only) from the app origin are allowed
  // (permissionPolicy); the rest, camera and screen capture included, is denied.
  const appUrl = backendUrl;
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(
      permissionPolicy(permission, details.requestingUrl, appUrl, {
        mediaTypes: 'mediaTypes' in details ? (details.mediaTypes ?? []) : undefined,
      }),
    ),
  );
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    permissionPolicy(permission, requestingOrigin, appUrl, { mediaType: details.mediaType }),
  );

  const window = createWindow(resources.icon);
  await window.loadURL(backendUrl);
  if (isSmoke) {
    try {
      if (shutdownRequested) return;
      smokeResult = await runSmoke(window);
      if (shutdownRequested) return;
      writeReport();
      logLifecycle('smoke da janela, API e persistência concluído');
      await requestQuit(0);
    } catch (error) {
      if (shutdownRequested) return;
      const message = error instanceof Error ? error.message : 'Falha no smoke desktop.';
      smokeResult = { ok: false, error: message };
      writeReport();
      logLifecycle('smoke desktop falhou');
      await requestQuit(1);
    }
  }
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', (event) => {
  if (quitAllowed) return;
  event.preventDefault();
  void requestQuit(requestedExitCode);
});

app.on('window-all-closed', () => {
  void requestQuit(0);
});
app.on('will-quit', () => {
  if (backend?.pid !== undefined) {
    try {
      backend.kill();
    } catch {
      /* Last-resort fallback after Electron shutdown was requested. */
    }
  }
});
process.once('SIGINT', () => {
  void requestQuit(0);
});
process.once('SIGTERM', () => {
  void requestQuit(0);
});

app
  .whenReady()
  .then(() => startDesktop())
  .catch((error: unknown) => {
    if (shutdownRequested) {
      void requestQuit(requestedExitCode);
      return;
    }
    const failure = error instanceof Error ? error : new Error('Falha inesperada ao iniciar o Adelic.');
    void showStartupFailure(failure);
  });
