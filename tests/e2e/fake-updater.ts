// Scripted "Atualizar Adelic" for the E2E server: a checkout two commits behind origin/master.
// apply walks the steps with short pauses, then "restarts" by flipping the commit and the
// boot id, the way a real restart looks to the UI. Never touches git or npm.
import { randomUUID } from 'node:crypto';
import type { SelfUpdateStatus, UpdateChannel, UpdateProgress, UpdateStepId } from '../../shared/contracts.js';
import type { SelfUpdater } from '../../server/self-update.js';

const OLD = 'a1b2c3d4e5f6';
const NEW = 'f6e5d4c3b2a1';
const COMMITS = [
  { hash: 'f6e5d4c', subject: 'feat: botão Atualizar Adelic' },
  { hash: 'b7c8d9e', subject: 'fix: reconectar depois de reiniciar' },
];
const STEPS: [UpdateStepId, string][] = [
  ['fetch', 'Buscar atualizações'],
  ['switch', 'Trocar de branch'],
  ['merge', 'Avançar o branch (fast-forward)'],
  ['install', 'Instalar dependências (npm ci)'],
  ['build', 'Compilar (npm run build)'],
  ['restart', 'Reiniciar'],
];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function createFakeUpdater() {
  let commit = OLD;
  let bootId = randomUUID();
  let checked = false;
  let progress: UpdateProgress = { state: 'idle', steps: [], log: '' };
  const status = (channel: UpdateChannel): SelfUpdateStatus => {
    const behind = checked && commit === OLD ? 2 : 0;
    const busy = progress.state === 'running' || progress.state === 'restarting';
    return {
      kind: 'checkout',
      version: '0.4.0',
      commit,
      bootId,
      channel,
      releaseUrl: 'https://github.com/ikaromm/Adelic/releases',
      available: behind > 0,
      canApply: behind > 0 && !busy,
      busy,
      ...(checked ? { checkedAt: new Date().toISOString() } : {}),
      ...(behind ? { target: NEW } : {}),
      checkout: {
        branch: channel,
        head: commit,
        behind,
        ahead: 0,
        clean: true,
        commits: behind ? COMMITS : [],
        install: false,
      },
    };
  };
  async function run() {
    for (const [id] of STEPS) {
      const step = progress.steps.find((s) => s.id === id)!;
      if (id === 'switch' || id === 'install') {
        step.status = 'skipped';
        continue;
      }
      step.status = 'running';
      progress.log += `> ${step.label}\n`;
      await sleep(id === 'restart' ? 300 : 500);
      if (id === 'restart') {
        progress.state = 'restarting';
        await sleep(1200);
        // The "new process": another commit and boot id, idle again.
        commit = NEW;
        bootId = randomUUID();
        progress = { state: 'idle', steps: [], log: '' };
        return;
      }
      step.status = 'done';
    }
  }
  const service: SelfUpdater = {
    async status(settings) {
      return status(settings.updateChannel ?? 'master');
    },
    async check(settings, _guard, channel) {
      checked = true;
      return status(channel ?? settings.updateChannel ?? 'master');
    },
    async apply(_settings, guard, options) {
      if (progress.state === 'running' || progress.state === 'restarting')
        throw Object.assign(new Error('Uma atualização já está em andamento'), { status: 409 });
      if (options.target && options.target !== NEW)
        throw Object.assign(new Error('mudou desde a verificação'), { status: 409 });
      const release = guard.begin();
      progress = {
        state: 'running',
        steps: STEPS.map(([id, label]) => ({ id, label, status: 'pending' })),
        log: '',
        target: NEW,
        startedAt: new Date().toISOString(),
      };
      void run().finally(release);
      return progress;
    },
    progress: () => progress,
  };
  return {
    service,
    reset() {
      commit = OLD;
      checked = false;
      bootId = randomUUID();
      progress = { state: 'idle', steps: [], log: '' };
      return { commit };
    },
  };
}
