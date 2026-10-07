# Compactação de conversas

2026-10-07. Pedido: compactar uma conversa longa num resumo estruturado, que passa a ser o ponto de partida das próximas mensagens, de forma manual ou, se o usuário ligar, automática.

## Manual

- **Compactar conversa**: menu **Ações da conversa** (⋯) no cabeçalho da conversa.
- **`/compactar`** digitado como a mensagem inteira faz o mesmo. O servidor reconhece o comando antes de expandir comandos salvos. `compactar` é um nome reservado: comandos salvos e arquivos `.adelic/commands/compactar.md` com esse nome são recusados (400 na API, aviso em Configurações). `/compactar texto` responde 400. Não cria balão do usuário, só o cartão do resumo. Na fila, roda quando a conversa fica livre e não pode orientar um turno.

Faz **uma** chamada ao agente da conversa, como uma execução própria, sem mensagens. A chamada usa o caminho rápido quando o agente oferece, ferramentas desligadas, sandbox `read-only` e nenhum histórico nativo. Pedidos de aprovação são negados sem perguntar. O prompt pede, em português, as seções Objetivo, Decisões, Estado atual, Arquivos e comandos, Perguntas em aberto e Próximos passos.

A entrada tem limite. Entram as mensagens mais recentes depois do último resumo, até 60 000 caracteres no total e 12 000 por mensagem. A primeira que não cabe é cortada pelo início, e as mais antigas são contadas como omitidas. O resumo anterior entra inteiro (até 12 000 caracteres), então cada resumo incorpora o anterior.

## Efeito

- O resumo fica salvo como `Compaction { id, sessionId, runId, summary, upToMessageId, createdAt, auto? }`.
- Na conversa, o cartão **Resumo da conversa** aparece no ponto da compactação. As mensagens que ele cobre ficam recolhidas em **Mensagens anteriores ao resumo (N)**, continuam visíveis ao abrir e continuam na busca e na exportação. Resumos antigos aparecem como **Resumo anterior**, recolhidos.
- As próximas execuções recebem `[resumo] + mensagens depois de upToMessageId` (`RunInput.summary` e `history`). O resumo fica fora do orçamento de histórico e tem limite próprio. Planejador e executores o recebem; revisão e síntese, não.
- `Session.nativeSessionId` é apagado. A próxima mensagem abre uma sessão nativa nova, alimentada pelo resumo (sem isso, a compactação não teria efeito no Codex).
- Vale o resumo mais recente.
- Se a chamada falha ou é cancelada, nada muda: o erro aparece na conversa e a sessão nativa continua. Mensagens na fila seguem depois de uma falha.

## Automática (opcional)

**Configurações › Agentes e respostas › Compactar automaticamente conversas longas** vem desligado. Desligado, nenhuma mensagem faz chamada extra. Ligado, com o **Limite para compactar** (padrão 150 000, entre 1 000 e 2 000 000), a compactação dispara se houver ao menos uma troca desde o último resumo e uma destas condições valer:

- a última execução depois do último resumo informou mais tokens de entrada que o limite; ou
- o histórico desde o último resumo passa de 4× o limite em caracteres (agentes que não informam tokens).

A compactação roda **antes** de a mensagem começar, dentro da execução dela, nunca no meio de uma resposta. A atividade mostra "Compactando a conversa…" e, depois, o motivo. Tarefas de um plano aprovado não disparam. Se o resumo falha, a mensagem segue com o histórico completo e a atividade registra "Não foi possível compactar a conversa (…); a mensagem seguiu sem compactar."

## Persistência e API

Migração 8: `compactions(id, session_id, data)`, com `ON DELETE CASCADE` de `sessions`. A versão 7 está reservada para outro ramo. As execuções de compactação manual levam `run.compaction = { auto: false }`. `GET /api/sessions/:id` traz `compactions`, e o stream envia `{ type: 'compaction', compaction }`.

| Método e caminho                   | Corpo | Efeito                                                                                         |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `POST /api/sessions/:id/compact`   | `{}`  | 202 `{ runId }`; 409 com execução ativa, plano em execução ou nada novo para resumir; 404 |
| `GET /api/sessions/:id/compactions` | —    | `{ compactions }`, do mais antigo ao mais recente                                              |

Configurações: `autoCompact` (booleano) e `autoCompactTokens` (inteiro de 1 000 a 2 000 000), validados com zod.

## Limites

- O resumo é escrito pelo próprio agente e pode omitir detalhes. As mensagens originais continuam guardadas, mas não voltam ao contexto. Para recuperar algo, cite-o de novo.
- O limite de tokens depende do que o agente informa (o Codex informa). Sem tokens, vale a estimativa por caracteres.
- Conversas com orquestração usam o resumo nas fases que recebem o pedido. O resumo do projeto (brief) não muda.
