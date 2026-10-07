# Fila de mensagens durante a execução

## Comportamento

- Com o agente trabalhando, o campo de mensagem continua ativo. **Enter** coloca a mensagem na fila da conversa (botão de fila ao lado do de parar faz o mesmo). Sem execução ativa, Enter envia normalmente.
- A fila aparece acima do campo como "Na fila (N)", com editar, remover, enviar agora e, quando o agente permite, orientar. No máximo 20 mensagens; cada uma tem o mesmo limite de uma mensagem comum (32000 caracteres).
- Quando a execução **termina com sucesso**, o servidor inicia a próxima mensagem da fila, na ordem.
- Quando a execução é **cancelada** pelo usuário, **falha** ou é **interrompida** por reinício do Adelic, a fila **pausa** ("Fila pausada", com o motivo) e nada começa sozinho. **Retomar fila** limpa a pausa e inicia a próxima mensagem. Remover a última mensagem também limpa a pausa.
- **Enviar agora (interrompe)**: **Ctrl+Enter** no campo ou o botão de raio de um item. Com execução ativa, pede confirmação, cancela a execução atual e inicia a mensagem escolhida; o restante da fila mantém a ordem e continua depois, sem pausar.
- **Orientar** (somente com `capabilities.steer: true`): envia o item ao turno em andamento sem interromper; o item sai da fila e a atividade registra "Orientação enviada ao agente".

## Persistência e API

A fila fica no servidor (SQLite, migração 4: `message_queue(id, session_id, position, data)` e `message_queue_state(session_id, data)` para a pausa, ambas com `ON DELETE CASCADE` de `sessions`). Sobrevive a recarregar a página e é a mesma em outro dispositivo. Ao abrir a base, filas com itens ficam pausadas (`interrupted`). A versão 3 está reservada para outro ramo; versões pendentes rodam em ordem.

| Método e caminho                             | Corpo                            | Efeito                                                       |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| `GET /api/sessions/:id/queue`                | —                                | `{ sessionId, items, paused? }`                              |
| `POST /api/sessions/:id/queue`               | `{ content, clientId? }`         | 201 na fila; 202 se a conversa estava livre e já começou     |
| `PATCH /api/sessions/:id/queue/:itemId`      | `{ content }`                    | Edita o texto, mantendo a posição                            |
| `DELETE /api/sessions/:id/queue/:itemId`     | `{}`                             | Remove o item (204)                                          |
| `POST /api/sessions/:id/queue/resume`        | `{}`                             | Limpa a pausa e inicia a próxima, se livre                   |
| `POST /api/sessions/:id/queue/:itemId/steer` | `{}`                             | Orienta o turno ativo; 409 se nenhum agente aceitar          |
| `POST /api/sessions/:id/send-now`            | `{ content, clientId? }` ou `{ itemId }` | Cancela a execução ativa e inicia esta mensagem      |

`clientId` torna o envio idempotente: repetido, devolve o item já na fila ou a execução já iniciada. Cada mudança emite o evento de stream `{ type: 'queue', queue }`. Uma mensagem que falha ao iniciar volta para o início da fila e a fila pausa.

## Orientação (steering): o que foi verificado

- Codex: o `codex-cli 0.160.0` local anuncia `turn/steer` no protocolo do app-server (`codex app-server generate-ts`: `TurnSteerParams { threadId, input: UserInput[], expectedTurnId, clientUserMessageId? }`, resposta `{ turnId }`). Uma chamada real com uma thread inexistente respondeu "thread not found", e não "unknown variant", o que confirma que o método existe. O Codex informa `steer: true`; a orientação usa o `turnId` do turno ativo e é recusada quando há mais de uma tarefa do Codex em paralelo na mesma execução. O efeito sobre um turno real não foi testado com modelo, só contra o app-server simulado dos testes.
- Kiro (ACP), Claude e OpenCode: sem método verificado, `steer: false`. A interface oferece só **Enviar agora (interrompe)**.

## Limites

- Com a fila pausada e nada em execução, Enter envia direto, sem passar pela fila; a fila continua pausada.
- A fila não altera provedor, modelo nem modo; cada item usa a configuração da conversa no momento em que começa.
- Excluir a conversa descarta a fila.
