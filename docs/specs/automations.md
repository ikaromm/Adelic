# Automações agendadas

2026-10-07. Pedido: rodar um pedido sozinho num horário (todo dia, em dias da semana ou a cada N horas), cada automação na sua própria conversa.

## Só com o Adelic aberto

O agendador vive dentro do processo do servidor do Adelic: um único `setTimeout` até a próxima ocorrência, recalculado a cada mudança e limpo ao encerrar. Não há cron, serviço do sistema, unidade systemd nem nada que rode com o Adelic fechado. A espera máxima é de 1 hora; ocorrências mais distantes são reavaliadas, o que absorve mudanças no relógio.

## Segurança

- **Desligado por padrão**, em dois níveis. **Configurações › Agentes e respostas › Automações ativadas** (`settings.automations`) é o interruptor geral: desligado, nada roda, nem "Executar agora". Cada automação também nasce desligada, e nenhuma vem pré-criada.
- Cada execução usa o sandbox e o modo de aprovação das Configurações, como uma mensagem digitada. Comandos salvos (`/revisar`) e `/plano` funcionam no pedido.
- **Nunca há aprovação automática.** Um pedido de aprovação espera por você, e as [notificações](notifications.md) avisam. A opção **Negar aprovações automaticamente após N minutos** (padrão 30, de 1 a 1440, pode ser desligada) nega as aprovações pendentes das execuções da automação depois do prazo. Ela não afeta conversas iniciadas por você.
- Duas ocorrências nunca rodam ao mesmo tempo. Se a conversa da automação tiver uma execução, um início em andamento ou um plano executando, a ocorrência é ignorada e fica registrada como "ignorada: execução em andamento".

## Agenda

| Tipo | Campos | Cálculo |
| --- | --- | --- |
| Diária | `time` `HH:MM` | Hora local no fuso `timezone` |
| Semanal | `days` (0 = domingo … 6 = sábado), `time` | Idem, só nos dias escolhidos |
| Intervalo | `hours` (1 a 168) | Horas reais a partir de quando foi ligada ou teve a agenda alterada |

O fuso é um nome IANA (padrão: o do sistema). O cálculo usa `Intl.DateTimeFormat`. Na mudança de horário de verão, um horário que não existe (02:30 quando o relógio pula de 02:00 para 03:00) roda depois do salto (03:30), e um horário repetido roda uma vez, na primeira ocorrência. O intervalo conta horas reais e não segue o relógio de parede.

**Recuperar ao abrir** (`catchUp`, padrão desligado): se o Adelic estava fechado no horário, ou o computador estava suspenso (o timer disparou mais de 15 min atrasado), a automação roda uma vez ao abrir. Desligado, a ocorrência perdida é pulada. Em ambos os casos a próxima é calculada a partir de agora, e ligar o interruptor geral nunca dispara um acúmulo.

## Conversa

A primeira execução cria a conversa "⏱ <nome>" no projeto, e as seguintes a reutilizam. Cada execução acrescenta uma mensagem do usuário com o pedido, marcada como automática (`Message.automationId`, selo "Automação"). Agente, modelo e modo da automação, quando definidos, são aplicados à conversa antes de cada execução; trocar agente ou modelo inicia uma sessão nativa nova. Se a conversa for excluída, outra é criada na próxima execução. Excluir a automação mantém a conversa.

## Persistência e API

Migração 10: `automations(id, project_id NOT NULL, data)`, com `ON DELETE CASCADE` de `projects`. Toda automação pertence a um projeto, sem automações avulsas. A versão 9 está reservada para outro ramo.

| Método e caminho | Corpo | Efeito |
| --- | --- | --- |
| `GET /api/automations` | — | `{ automations, enabled }` (`enabled` = interruptor geral) |
| `POST /api/automations` | `{ name, prompt, projectId, schedule, timezone?, providerId?, model?, mode?, enabled?, catchUp?, denyApprovalsAfterMinutes? }` | 201, desligada salvo `enabled: true`; 404 para projeto desconhecido |
| `PATCH /api/automations/:id` | campos parciais; `null` em `providerId`, `model` ou `mode` volta ao padrão | Recalcula `nextRunAt` |
| `DELETE /api/automations/:id` | `{}` | 204 |
| `POST /api/automations/:id/run` | `{}` | 202 `{ automation, runId, messageId }`; 409 com o interruptor geral desligado ou a conversa ocupada |

Limites: nome até 80 caracteres e pedido até 8000. Cada mudança emite o evento de stream `{ type: 'automations' }`. `lastResult` guarda `{ runId?, status, at, trigger: schedule | catch-up | manual, detail? }`. Execuções cortadas por um reinício aparecem como `interrupted`.

## Interface

**Automações** na barra lateral (e na paleta) lista cada automação com agenda, próxima execução, último resultado, interruptor, **Executar agora**, **Abrir conversa**, editar e excluir (com confirmação). O formulário valida com as mesmas mensagens da API e mostra as 3 próximas execuções.

## Limites

- Nada roda com o Adelic fechado. A recuperação ao abrir executa no máximo uma vez por automação.
- "Executar agora" funciona com a automação desligada, desde que o interruptor geral esteja ligado; o interruptor da automação vale só para a agenda.
