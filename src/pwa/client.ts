// Installable-app client (docs/specs/pwa.md): registers /sw.js, tracks a waiting update and
// the browser's install prompt, and exposes both to React through a tiny external store.
import { useSyncExternalStore } from 'react';
import { SKIP_WAITING } from './sw';

export interface RegistrationEnv {
  production: boolean;
  secureContext: boolean;
  userAgent: string;
  hasServiceWorker: boolean;
}

/**
 * Only production builds in a secure context (HTTPS or localhost) register the worker. The
 * desktop app (Electron) never does: it always talks to its own local backend.
 */
export const shouldRegister = (env: RegistrationEnv) =>
  env.production && env.secureContext && env.hasServiceWorker && !/\bElectron\//.test(env.userAgent);

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** A new version is installed and waiting for the user to accept it. */
  updateReady: boolean;
  /** The browser offered installation (beforeinstallprompt). */
  installable: boolean;
  /** Running as an installed app (standalone window). */
  standalone: boolean;
}

let state: PwaState = { updateReady: false, installable: false, standalone: false };
let waiting: ServiceWorker | null = null;
let installPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<PwaState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export const pwaStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export function usePwa() {
  return useSyncExternalStore(pwaStore.subscribe, pwaStore.get, pwaStore.get);
}

function track(registration: ServiceWorkerRegistration) {
  const offer = (worker: ServiceWorker | null) => {
    // Without a controller this is the first install, not an update.
    if (!worker || !navigator.serviceWorker.controller) return;
    waiting = worker;
    set({ updateReady: true });
  };
  offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(installing);
    });
  });
  // Long-lived tabs (an installed app stays open) look for a new version when shown again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
  });
}

/** Accepts the update: the waiting worker takes over and the page reloads once. */
export function applyUpdate() {
  if (!waiting) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  waiting.postMessage({ type: SKIP_WAITING });
}

export async function promptInstall() {
  const event = installPrompt;
  if (!event) return;
  installPrompt = null;
  set({ installable: false });
  await event.prompt();
  await event.userChoice.catch(() => undefined);
}

/** Called once from main.tsx, before the first render, so an early install prompt is kept. */
export function startPwa() {
  set({ standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    set({ installable: true });
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    set({ installable: false });
  });
  const env: RegistrationEnv = {
    production: import.meta.env.PROD,
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    hasServiceWorker: 'serviceWorker' in navigator,
  };
  if (!shouldRegister(env)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      // Some environments stub register() and resolve without a registration.
      .then((registration) => registration && track(registration))
      .catch(() => undefined);
  });
}
