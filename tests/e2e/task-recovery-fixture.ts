import type { Express } from 'express';
import { writeFileSync } from 'node:fs';
import type { DelegatedTask, SessionWorktree } from '../../shared/contracts.js';
import { createExecutorWorktree } from '../../server/worktrees.js';
import type { Store } from '../../server/store.js';

export function installRecoveryFixture(app: Express, store: Store, dataDir: string) {
  app.post('/e2e/task-recovery/seed', async (req, res) => {
    const project = store.getProject(String(req.body?.projectId || ''));
    const session = store.getSession(String(req.body?.sessionId || ''));
    if (!project || !session || session.projectId !== project.id)
      return res.status(400).json({ error: 'fixture inválida' });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = store.listRuns(session.id).at(-1)?.id;
    if (!runId) return res.status(409).json({ error: 'execute uma conversa real antes de semear a fixture' });
    const now = new Date().toISOString();
    const siblingId = `e2e-delivered-${suffix}`;
    const pendingId = `e2e-pending-${suffix}`;
    const noChangesId = `e2e-no-changes-${suffix}`;
    const interruptedId = `e2e-interrupted-${suffix}`;
    const legacyId = `e2e-legacy-${suffix}`;
    // Use the same producer as real executor worktrees so every known recovery record carries
    // the snapshot tree, branch proof and creation-bound marker required by the current contract.
    const noChangesWorktree = await createExecutorWorktree(
      project,
      { id: noChangesId, title: 'Tarefa sem alterações' },
      dataDir,
    );
    const interruptedWorktree = await createExecutorWorktree(
      project,
      { id: interruptedId, title: 'Conclusão antes da integração' },
      dataDir,
    );
    const legacyWorktree = await createExecutorWorktree(
      project,
      { id: legacyId, title: 'Recuperação legada desconhecida' },
      dataDir,
    );
    writeFileSync(`${interruptedWorktree.path}/recovery.txt`, 'alteração preservada antes da integração\\n');
    // These are explicitly synthetic terminal task states: the provider is not invoked here.
    // Git creation/snapshot/ownership are real, while the task execution facts model the E2E
    // terminal states that recovery is designed to reload and reconcile.
    const syntheticCompletedWorktree = (worktree: SessionWorktree): SessionWorktree => ({
      ...worktree,
      ownershipVerified: true,
      executionStarted: true,
      recoveryEvidence: {
        intentRecorded: true,
        creation: 'confirmed',
        ownership: 'confirmed',
        preparation: 'complete',
        taskExecution: 'started',
      },
    });
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
        recoveryWorktree: syntheticCompletedWorktree(noChangesWorktree),
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
        recoveryWorktree: syntheticCompletedWorktree(interruptedWorktree),
        delivery: {
          status: 'partial',
          reason: 'Processo concluído; alterações existem somente no checkout isolado.',
          evidence: ['artifact:recovery.txt', 'integration:pending'],
          recovery: { action: 'recover_worktree', reason: 'Inspecionar ou integrar checkout preservado.' },
          recordedAt: now,
        },
      },
      {
        ...common,
        id: legacyId,
        agentId: legacyId,
        title: 'Recuperação legada desconhecida',
        instructions: 'Registro legado sem prova de continuidade.',
        status: 'completed',
        output: 'A continuidade não pode ser comprovada.',
        // Emulate a pre-contract persisted record: its real checkout exists, but the stored
        // metadata intentionally omits the proof. It must remain inspect/apply/discard blocked.
        recoveryWorktree: {
          path: legacyWorktree.path,
          branch: legacyWorktree.branch,
          base: legacyWorktree.base,
          createdAt: legacyWorktree.createdAt,
        },
        delivery: {
          status: 'unverified',
          reason: 'Registro legado sem evidência suficiente.',
          evidence: ['artifact:unknown'],
          recovery: { action: 'inspect', reason: 'Inspecionar sem alterar recursos desconhecidos.' },
          recordedAt: now,
        },
      },
    ];
    tasks.forEach((task) => store.putTask(task));
    res
      .status(201)
      .json({ runId, siblingId, pendingId, noChangesId, interruptedId, legacyId, projectPath: project.path });
  });
}
