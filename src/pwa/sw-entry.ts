// Entry bundled to /sw.js by vite.config.ts; the build replaces the two constants below.
import { installWorker, type WorkerScope } from './sw';

declare const __ADELIC_SW_VERSION__: string;
declare const __ADELIC_SW_PRECACHE__: string[];

installWorker(self as unknown as WorkerScope, { version: __ADELIC_SW_VERSION__, precache: __ADELIC_SW_PRECACHE__ });
