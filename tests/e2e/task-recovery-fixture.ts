import type { Express } from 'express';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DelegatedTask } from '../../shared/contracts.js';
import type { Store } from '../../server/store.js';

export function installRecoveryFixture(app: Express, store: Store, dataDir: string) {
  app.post('/e2e/task-recovery/seed', (req, res) => {
    const project = store.getProject(String(req.body?.projectId || ''));
    const session = store.getSession(String(req.body?.sessionId || ''));
    if (!project || !session || session.projectId !== project.id)
      return res.status(400).json({ error: 'fixture inválida' });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = store.listRuns(session.id).at(-1)?.id;
    if (!runId) return res.status(409).json({ error: 'execute uma conversa real antes de semear a fixture' });
    const now = new Date().toISOString();
    const base = spawnSync('git', ['-C', project.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (base.status !== 0) return res.status(400).json({ error: 'projeto precisa ser um repositório Git com commit' });
    const worktreePath = join(dataDir, 'recovery-worktrees', suffix);
    const branch = `adelic/e2e-recovery-${suffix}`;
    const added = spawnSync('git', ['-C', project.path, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD'], {
      encoding: 'utf8',
    });
    if (added.status !== 0) return res.status(500).json({ error: added.stderr });
    writeFileSync(join(worktreePath, 'recovery.txt'), 'alteração preservada antes da integração\n');
    const noChangesWorktreePath = join(dataDir, 'recovery-worktrees', `${suffix}-no-changes`);
    const noChangesBranch = `adelic/e2e-no-changes-${suffix}`;
    const noChangesAdded = spawnSync(
      'git',
      ['-C', project.path, 'worktree', 'add', '-b', noChangesBranch, noChangesWorktreePath, 'HEAD'],
      { encoding: 'utf8' },
    );
    if (noChangesAdded.status !== 0) return res.status(500).json({ error: noChangesAdded.stderr });
    const common = {
      projectId: project.id,
      sessionId: session.id,
      runId,
      role: 'worker' as const,
      scope: ['recovery.txt'],
      dependsOn: [],
      providerId: 'codex' as const,
      model: 'e2e-model',
      createdAt: now,
      completedAt: now,
    };
    const siblingId = `e2e-delivered-${suffix}`;
    const pendingId = `e2e-pending-${suffix}`;
    const noChangesId = `e2e-no-changes-${suffix}`;
    const interruptedId = `e2e-interrupted-${suffix}`;
    const tasks: DelegatedTask[] = [
      {
        ...common,
        id: siblingId,
        agentId: siblingId,
        title: 'Irmã já entregue',
        instructions: 'Criar a entrega concluída.',
        status: 'completed',
        output: 'Irmã entregue sem necessidade de repetição.',
        delivery: {
          status: 'implemented',
          reason: 'Entrega integrada.',
          evidence: ['integration:applied'],
          recovery: { action: 'inspect', reason: 'Inspecionar evidências.' },
          recordedAt: now,
        },
        integration: {
          status: 'applied',
          cleanup: 'complete',
          reason: 'Alterações aplicadas e checkout removido.',
          recordedAt: now,
        },
      },
      {
        ...common,
        id: pendingId,
        agentId: pendingId,
        title: 'Tarefa pendente específica',
        instructions: 'E2E retry only [eco] marcador-pendente.',
        status: 'failed',
        error: 'Falha simulada antes de terminar',
        output: '',
        delivery: {
          status: 'blocked',
          reason: 'Processo falhou; tarefa pendente.',
          evidence: ['process:failed'],
          recovery: { action: 'retry', reason: 'Retomar somente esta tarefa pendente.' },
          recordedAt: now,
        },
      },
      {
        ...common,
        id: noChangesId,
        agentId: noChangesId,
        title: 'Tarefa sem alterações',
        instructions: 'A implementação não alterou arquivos.',
        status: 'completed',
        output: 'Concluída sem mudanças.',
        recoveryWorktree: {
          path: noChangesWorktreePath,
          branch: noChangesBranch,
          base: base.stdout.trim(),
          createdAt: now,
        },
        delivery: {
          status: 'not_implemented',
          reason: 'O processo terminou sem alterações; nenhuma entrega foi aplicada.',
          evidence: ['artifact:no-changes'],
          recovery: { action: 'retry', reason: 'Retomar somente esta tarefa pendente.' },
          recordedAt: now,
        },
      },
      {
        ...common,
        id: interruptedId,
        agentId: interruptedId,
        title: 'Conclusão antes da integração',
        instructions: 'Concluída em worktree; integração ainda pendente.',
        status: 'completed',
        output: 'Processo concluído; integração interrompida.',
        recoveryWorktree: { path: worktreePath, branch, base: base.stdout.trim(), createdAt: now },
        delivery: {
          status: 'partial',
          reason: 'Processo concluído; alterações existem somente no checkout isolado.',
          evidence: ['artifact:recovery.txt', 'integration:pending'],
          recovery: { action: 'recover_worktree', reason: 'Inspecionar ou integrar checkout preservado.' },
          recordedAt: now,
        },
      },
    ];
    tasks.forEach((task) => store.putTask(task));
    res.status(201).json({ runId, siblingId, pendingId, noChangesId, interruptedId, projectPath: project.path });
  });
}
