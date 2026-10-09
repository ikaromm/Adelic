# Validação de runtime e recuperação — 2026-10-08

## Estado desta rodada

**Parcial/bloqueada para os cenários integrados reais.** Este executor disponibilizou o checkout e as ferramentas de teste, mas não um backend Adelic em execução nem a harness operacional de tarefas/provedores. A inspeção de portas não encontrou listener TCP; portanto, não foi possível reiniciar um backend Adelic, identificar o código carregado por um processo real ou submeter tarefas a codificadores Luna/high e revisor independente via Adelic. Não há registro novo de modelo nesta rodada. A fonte alterada no checkout não é evidência de runtime atualizado.

Não foram usados segredos/credenciais, nem feitas chamadas de modelo, commits, publicação ou deploy. As mudanças preexistentes no checkout foram preservadas.

## Evidência nova desta rodada

- `npx vitest run tests/worktrees.test.ts tests/run-artifacts.test.ts tests/run-artifacts-http.test.ts tests/coordination-lifecycle.test.ts tests/ui-task-recovery.test.ts tests/remote-runner.test.ts tests/remote-transport.test.ts tests/local-executor.test.ts --maxWorkers=2`: **8 arquivos passaram; 56 testes passaram, 4 ignorados**. Isso cobre regressões unitárias de isolamento/worktrees, artefatos de entrega, estado parcial de coordenação, recuperação e executor. Os 4 ignorados não validam SSH real.
- `npm run typecheck`: passou.
- ESLint nos arquivos de produção e testes relevantes de worktrees, coordenação, entrega, recuperação e executores: passou sem saída/erros.
- `npx playwright test tests/e2e/run-artifacts.spec.ts tests/e2e/task-recovery.spec.ts`: **3 cenários não iniciaram**. Playwright não encontrou `chromium_headless_shell` no cache isolado. O diagnóstico encontrou um executável `chromium`, mas isso não comprova que o browser do Playwright ou a automação estejam funcionais. Não instalei browser.
- A fixture SSH real foi tentada separadamente. `sshd` existe, mas `USER` está ausente e a namespace não tem entrada passwd para UID 1000 (`id -u` deu 1000; `id -un`/`ssh-keygen` falhou: “No user exists for uid 1000”). O teste terminou com falha de preparação e 8 casos ignorados; **não houve conexão SSH nem sondagem read-only**. Não tentei contornar a identidade do executor.
- O diagnóstico do executor confirmou Git acessível e `/tmp` gravável, mas `/var/tmp` não gravável. Isso não prova disponibilidade de infraestrutura fora deste namespace.

Os 56 testes aprovados acima são o resultado **novo e direcionado** desta rodada, não uma soma com a validação anterior. A revalidação registrada em `docs/validation/harness-revalidation-0.5.3.md` relata outra árvore/rodada: 1.363 testes unitários aprovados, um ignorado, mais testes e2e. Esses totais anteriores não foram reexecutados nem são evidência de runtime Adelic carregado aqui.

## Escopo parcialmente coberto e lacunas

Os testes de `tests/worktrees.test.ts`, `tests/coordination-lifecycle.test.ts`, `tests/run-artifacts.test.ts`, `tests/run-artifacts-http.test.ts` e `tests/ui-task-recovery.test.ts` passaram. Eles verificam os contratos testados de isolamento e integração de resultados, eventos/artefatos, estados de entrega/recuperação e conflito. São testes da aplicação sob fixtures, não uma demonstração de tarefas reais executadas em worktrees por agentes. Os testes E2E relevantes não chegaram a abrir browser.

O caminho SSH read-only, incluindo ler seguido de tentar substituir sem alteração, permanece **não validado nesta rodada** porque o harness local não conseguiu iniciar. A suíte pode ser reexecutada quando houver uma identidade de usuário mapeada e uma instalação configurada para iniciar seu próprio sshd descartável.

A mudança de instruções de contexto e diagnóstico, relatada como implementada nos artefatos de trabalho anteriores, também não foi sondada em um processo Adelic atualizado nesta rodada. O carregamento em runtime requer iniciar/reiniciar o backend isolado em ambiente com dependências operacionais e então confirmar a versão servida antes de enviar ferramentas/tarefas.

## Referências de implementação inspecionadas

- `server/worktrees.ts`, `server/orchestrator.ts`, `server/coordination.ts`
- `server/run-artifacts.ts`, `shared/observability.ts`
- `src/components/RunDelivery.tsx`, `src/components/TaskRecovery.tsx`, `src/components/RunProgressBanner.tsx`
- `server/remote/runner-source.ts`, `server/remote/transport.ts`, `server/local-executor.ts`
- Testes listados na seção de evidências.

A aprovação dos testes acima sustenta somente as asserções executadas nesses arquivos. Não prova, por si, ausência de conflitos em toda execução real, êxito de recuperação interativa, segurança de conexão SSH externa ou versão de runtime carregada.
