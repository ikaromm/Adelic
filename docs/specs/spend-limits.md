# Limites de uso

2026-10-07. Pedido: limites de tokens e de custo, desligados por padrão, que bloqueiam novas chamadas ao agente quando atingidos, com aviso antes e um jeito de continuar uma vez.

## Configuração

- **Configurações › Limites de uso › Limitar uso** vem desligado. Desligado, nada é conferido nem bloqueado.
- Limites globais, todos opcionais: **tokens por dia**, **tokens por mês**, **custo por dia** e **custo por mês** (US$). Campo vazio = sem limite.
- Por projeto (**Configurações** com o projeto aberto › **Uso do projeto**): **tokens por mês** e **custo por mês**, opcionais. Valem enquanto **Limitar uso** está ligado e só para conversas vinculadas ao projeto. Conversas avulsas seguem só os limites globais.
- Tokens = entrada + saída. Custo soma só as execuções que informaram custo; as outras aparecem como "custo não informado em N execuções", nunca como zero. O Codex informa tokens, mas não custo.
- Períodos no fuso local: o dia começa às 00:00 e o mês é o mês do calendário. Uma execução conta no período em que **começou**.

## O que é contado

Toda chamada de modelo do Adelic fica registrada numa execução (`runs`), e o uso é somado a partir delas:

- respostas diretas e coordenadas (planejador, executores, revisão e síntese somam na execução da mensagem);
- novas tentativas automáticas e tentativas com outro modelo (troca de modelo), inclusive as que falharam depois de consumir tokens;
- compactação manual (execução própria) e automática (soma na execução da mensagem);
- resumo de **Continuar com outro agente**: agora vira uma execução sem mensagens (`run.handoff`), que aparece em Atividade. O resumo local não chama modelo e não conta.

## Bloqueio

Antes de cada chamada nova, se algum limite configurado já foi atingido (uso ≥ limite), o servidor recusa com 409, `code: 'spend_limit'`, e a mensagem:

> Limite de uso atingido: tokens hoje (1.250.000/1.000.000). Ajuste em Configurações ou use 'Continuar mesmo assim'.

Pontos conferidos, sempre antes de qualquer chamada ao provedor e antes de a execução existir: enviar mensagem (inclui `/plano` e comandos salvos), editar e reenviar, **Tentar de novo** / **Tentar com outro modelo**, compactar (menu e `/compactar`), resumo de **Continuar com outro agente** (só com "Com resumo"), aprovar um plano e cada tarefa seguinte dele, e cada mensagem da fila. O Adelic não tem automações agendadas.

Uma execução em andamento nunca é interrompida por um limite, mesmo que passe dele. A compactação automática faz parte da mensagem que já começou e não é bloqueada.

**Continuar mesmo assim** reenvia o mesmo pedido com `overrideLimit: true`, que vale só para aquele pedido e nunca é salvo. Num plano em execução, vale só para a primeira tarefa; a seguinte confere de novo e, bloqueada, para o plano com o motivo no cartão.

## Fila

Uma mensagem da fila que encontra o limite volta para o início da fila e a fila pausa com `reason: 'limit'` e a mensagem acima. A fila mostra **Continuar mesmo assim** (inicia só a próxima mensagem, com `overrideLimit`) e **Retomar fila** (confere de novo).

## Aviso em 80%

Com algum limite em 80% ou mais, a conversa mostra uma faixa acima do campo de mensagem, sem bloquear: "Uso em 85% do limite de tokens hoje (850.000/1.000.000)." Dispensada, volta só quando outro limite entra no aviso ou quando um é atingido.

## API

| Método e caminho                    | Corpo / consulta                                                                                | Efeito                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/usage?projectId=`         | `projectId` opcional (404 se não existir)                                                       | `{ today, month, project?, limits, warnings, reached }`     |
| `PATCH /api/settings`               | `{ spendLimits: { enabled?, dailyTokens?, monthlyTokens?, dailyCostUsd?, monthlyCostUsd? } }`   | Mescla campo a campo; `null` remove um limite                |
| `PATCH /api/projects/:id`           | `{ spendLimits: { monthlyTokens?, monthlyCostUsd? } \| null }`                                  | Mescla; `null` remove um limite ou todos                     |

Tokens: inteiros não negativos. Custo: número não negativo com até 2 casas. Valores inválidos respondem 400. `today`/`month` trazem `{ from, to, tokens, costUsd (null se nenhuma informou), runs, runsWithoutCost, runsWithoutTokens }`. `warnings` lista os limites em 80% ou mais; `reached`, os atingidos.

`overrideLimit: true` é aceito por `POST /api/sessions/:id/messages`, `…/messages/:messageId/edit`, `…/queue` (se a mensagem começa na hora), `…/queue/resume`, `…/send-now`, `…/compact`, `…/handoff`, `/api/runs/:id/retry` e `/api/plans/:id/approve`.

## Agregação

Sob demanda, com uma consulta SQL por escopo sobre `runs`, usando `json_extract` em `startedAt` (texto ISO, comparado com os limites do período em UTC) e somas condicionais para hoje e o mês na mesma passada. Escolhida em vez de um contador em memória porque `runs` já é a fonte única: nada precisa ser sincronizado, reconstruído ao iniciar, nem corrigido quando uma execução é descartada ou a conversa é excluída. O custo é uma varredura de `runs` por conferência (milhares de linhas em poucos milissegundos); sem migração e sem índice novo. Se ficar lento, a migração 13 pode indexar `json_extract(data,'$.startedAt')`.

O uso por projeto segue o vínculo atual da conversa (`sessions.project_id`): mover uma conversa leva o uso dela junto.
