# Modo de planejamento: planejar, aprovar, executar

2026-10-06. Pedido: como as Specs do Kiro, o agente escreve primeiro um plano (requisitos, design e tarefas), o usuário revisa e aprova, e só então a execução começa, uma tarefa por vez.

## Quando planeja

Sempre por escolha do usuário, nunca automaticamente. Perguntas comuns continuam no caminho rápido, sem chamada extra de modelo.

- **Planejar antes** (botão no campo de mensagem, ao lado de projeto e modo): ligado, toda mensagem da conversa gera um plano. Fica salvo na conversa (`Session.planFirst`, `PATCH /api/sessions/:id { planFirst }`).
- **`/plano <pedido>`**: só esta mensagem gera um plano. O prefixo é reconhecido no servidor; `/plano` sem pedido responde 400.

## A execução de planejamento é somente leitura

Independentemente das configurações, a execução de planejamento recebe sandbox `read-only`, não grava checkpoint e não reserva o projeto para escrita. Pedidos de alteração de arquivo (`kind: 'file'`) são negados na hora, sem perguntar ao usuário, e aparecem na atividade como "Alteração negada: o planejamento é somente leitura". Comandos e ferramentas de leitura seguem a política de aprovação de sempre. É uma chamada direta ao agente da conversa, mesmo com orquestração ativa: o plano já é a divisão do trabalho.

O prompt pede, em português, um Markdown com `## Requisitos` (lista numerada e testável), `## Design` (abordagem e arquivos) e `## Tarefas` (checklist `- [ ] …`, cada item pequeno e verificável).

## Leitura do plano (`server/plan-markdown.ts`)

- Seções reconhecidas pelo nome do título em qualquer nível (`## Requisitos`, `### 2. Design`, `**Tarefas**`, `Tarefas:`, nomes em inglês), sem diferenciar acentos. Títulos dentro de blocos de código são ignorados, e uma cerca ```` ```markdown ```` em volta da resposta inteira é removida.
- Tarefas são os itens de primeiro nível da lista em Tarefas (com ou sem caixa); listas aninhadas e linhas recuadas viram os detalhes da tarefa. Até 50 tarefas de até 500 caracteres.
- Sem nenhuma seção, o texto inteiro vira o design e só itens `- [ ]` contam como tarefas. Sem tarefas, o cartão mostra "Não encontrei tarefas; edite o plano" e aprovar responde 409.
- Editar o Markdown e salvar relê o plano. Tarefas com o mesmo texto mantêm id, estado e execução.

## Cartão do plano

Aparece no lugar da resposta da execução de planejamento: título, estado, progresso ("1 de 2 tarefas concluídas"), Requisitos e Design recolhíveis e a lista de tarefas com o estado de cada uma, atualizado pelo stream (`{ type: 'plan', plan }`). Botões: **Aprovar e executar**, **Executar só a próxima tarefa**, **Descartar**, editar (lápis), pular / voltar tarefa, **Parar após a tarefa atual** durante a execução e **Salvar no projeto** depois de aprovado.

## Execução: uma tarefa por execução (`server/plans.ts`)

Aprovar inicia uma execução normal para a primeira tarefa pendente (ou que falhou): respeita sandbox, aprovações e checkpoints configurados, então cada tarefa tem seu próprio "Alterou N arquivos" e seu desfazer. A mensagem do usuário mostra "Tarefa 1/2 do plano: …"; o prompt traz o plano aprovado com o checklist atualizado e pede para fazer só a tarefa atual.

- A tarefa só fica **concluída** quando a execução termina com sucesso.
- **Falha**: a tarefa fica "Falhou" com o motivo, o plano para. Aprovar de novo repete essa tarefa; pular segue para a próxima.
- **Cancelar** a execução: a tarefa volta a pendente ("Cancelada pelo usuário") e o plano para.
- **Parar após a tarefa atual**: a tarefa em andamento termina; nenhuma outra começa.
- Em "todas", ao concluir uma tarefa a próxima começa sozinha; mensagens na fila esperam o plano terminar.
- Reinício do Adelic: tarefas em execução voltam a pendentes e o plano fica aprovado, esperando o usuário.

## Persistência e API

Migração 6: `plans(id, session_id, data)` com `ON DELETE CASCADE` de `sessions` (a versão 5 está reservada para outro ramo). As execuções levam `run.plan` (`{ kind: 'plan' }` ou `{ kind: 'task', planId, taskId }`).

| Método e caminho                     | Corpo                     | Efeito                                                     |
| ------------------------------------ | ------------------------- | ---------------------------------------------------------- |
| `GET /api/sessions/:id/plans`        | —                         | `{ plans }`                                                |
| `PATCH /api/plans/:id`               | `{ markdown }`            | Salva e relê o plano                                       |
| `POST /api/plans/:id/approve`        | `{ mode: 'all'\|'next' }` | 202 `{ plan, started }`; 409 sem tarefas pendentes         |
| `POST /api/plans/:id/tasks/:taskId`  | `{ status: 'skipped'\|'pending' }` | Pula ou devolve uma tarefa; 409 se concluída      |
| `POST /api/plans/:id/stop`           | `{}`                      | Para após a tarefa atual; 409 fora de execução             |
| `POST /api/plans/:id/discard`        | `{}`                      | Descarta (estado `rejected`)                               |
| `POST /api/plans/:id/save`           | `{ overwrite? }`          | Grava `<projeto>/.adelic/specs/<slug>.md`                  |

Todas respondem 404 para plano ou tarefa inexistente e 409 enquanto a conversa tem uma execução ativa (exceto parar).

## Salvar no projeto

Só quando o usuário clica, e só em conversa vinculada a projeto. O caminho é resolvido com `realpath`; se `.adelic/specs` ou o arquivo forem links simbólicos (ou saírem do projeto), nada é gravado (409). Arquivo existente responde 409 com `exists: true` e o cartão pergunta antes de **Substituir**; a criação usa `O_EXCL`, e a substituição grava em arquivo temporário e renomeia. `.adelic/` está no `.gitignore` deste repositório, mas não necessariamente no do projeto do usuário.

## Limites

- A negação automática vale para pedidos marcados como alteração de arquivo; o isolamento real é o sandbox somente leitura do runtime (bubblewrap do Adelic e a política de sandbox de cada agente). Agentes sem ferramentas planejam só com o pedido.
- O plano não pode ser editado durante a execução; edite depois de parar.
- Anexos da mensagem vão para a execução de planejamento, não para as tarefas.
