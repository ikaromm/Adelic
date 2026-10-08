import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { RemoteGate } from './RemoteGate';
import { startPwa } from './pwa/client';
import { UpdateToast } from './pwa/UpdateToast';
import './styles.css';
import { reportClientEvent } from './api';

// Installable app: service worker only in production, secure contexts and outside Electron.
startPwa();

// Report only event names and status. Error text, stacks, URLs, and rejection reasons stay local.
window.addEventListener('error', () => reportClientEvent('ui.error', 'error'));
window.addEventListener('unhandledrejection', () => reportClientEvent('ui.error', 'error'));

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="o Adelic" fullScreen>
      <RemoteGate>
        <App />
      </RemoteGate>
      <UpdateToast />
    </ErrorBoundary>
  </React.StrictMode>,
);
