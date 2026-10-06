import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary scope="o Adelic" fullScreen>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
