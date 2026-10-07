# Editar e reenviar, e ramificar uma conversa

2026-10-06. Pedido: corrigir uma mensagem já enviada sem começar outra conversa, e explorar um caminho alternativo sem perder o original.

## Editar e reenviar

- Em uma mensagem do usuário, o lápis (**Editar**, visível ao passar o mouse ou com foco) troca o balão por um editor. **Salvar e reenviar** substitui a mensagem e **descarta todas as mensagens seguintes** da conversa; depois inicia uma execução com o novo texto. Enter salva, Shift+Enter quebra linha, Esc cancela.
- Quando há mensagens depois, pede confirmação ("Reenviar descarta as N mensagens seguintes…").
- Anexos da mensagem continuam; o editor permite remover chips, não adicionar.
- Recusado (409) com execução ativa ou plano em execução na conversa; o botão fica desabilitado e explica o motivo.
- **Sessão nativa**: a thread do Codex e a sessão ACP do Kiro já contêm os turnos descartados e não podem ser rebobinadas. A edição remove `Session.nativeSessionId`; a próxima execução abre uma sessão nova e recebe no prompt o histórico restante (o mesmo caminho de quando não há sessão nativa: `boundedPrompt`/`selectHistory`). A execução editada vê só as mensagens anteriores à editada.

### O que acontece com o que foi descartado

Decisão: **apagar as mensagens, manter as execuções**.

- Mensagens a partir da editada são apagadas (`DELETE`), na mesma transação que grava a nova mensagem. Os gatilhos do `messages_fts` tiram as mensagens da busca; a exportação e o histórico deixam de mostrá-las.
- Os eventos das execuções descartadas (saída visível da atividade) são apagados.
- As execuções (`runs`) ficam para histórico e auditoria, marcadas com `Run.discardedAt`, incluindo tokens, custo e checkpoint (o desfazer continua acessível pela API). Tarefas delegadas também ficam, sem aparecer na conversa.
- Planos escritos por uma execução de planejamento descartada passam a `rejected`.
- A nova mensagem recebe um id novo.

## Ramificar daqui

- Em qualquer mensagem, **Ramificar daqui** cria uma conversa nova, "<título> (ramo)", com cópias das mensagens até ela, inclusive, e a abre. Mesmo projeto, provedor, modelo, modo, thinking e "Planejar antes"; sem `nativeSessionId`.
- Cópias têm ids novos; o par pergunta/resposta mantém um `runId` comum, novo, que não aponta para execução gravada. Anexos viram linhas e arquivos novos na pasta do ramo, então apagar a original não afeta o ramo. Planos, fila, execuções e eventos não são copiados. A original fica intacta.
- `Session.branchedFrom = { sessionId, messageId }`. O cabeçalho mostra **Ramo de <título>**, que abre a original enquanto ela existir.
- Recusado (409) para uma mensagem cuja resposta ainda está sendo escrita.

## API

| Método e caminho                                  | Corpo                                            | Resposta                  |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------- |
| `POST /api/sessions/:id/messages/:messageId/edit` | `{ content, attachmentIds?, clientMessageId? }`  | 202 `{ runId, messageId }` |
| `POST /api/sessions/:id/branch`                   | `{ messageId }`                                  | 201 `Session`             |

Validação com zod (`EditMessageSchema`, `BranchSessionSchema`). Sem `attachmentIds`, a edição mantém os anexos da mensagem; com a lista, usa só ela (cada id precisa pertencer à conversa, senão 400). 404 para conversa ou mensagem inexistente ou de outra conversa; 400 para editar mensagem que não é do usuário. `clientMessageId` torna a edição idempotente: repetida depois de aceita, devolve a execução já iniciada.

Sem migração: os campos novos ficam no JSON de `sessions.data` e `runs.data`.

## Limites

- Na edição, a interface não permite adicionar anexos novos.
- Outra aba aberta na mesma conversa remove as mensagens descartadas ao receber o evento `refresh`.
