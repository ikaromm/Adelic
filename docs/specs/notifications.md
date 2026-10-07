# Notificações

2026-10-06. Pedido: avisar quando uma execução termina, falha ou precisa de aprovação, sem ruído enquanto o usuário está olhando para o Adelic.

## Quando avisa

Só com a janela ou aba em segundo plano (`document.hidden` ou sem foco). Com a janela em foco, nada é mostrado.

| Evento | Título | Texto |
|---|---|---|
| Execução concluída | Resposta pronta | título da conversa |
| Execução falhou | Execução falhou | título da conversa e motivo curto (`run.failure.reason`, senão `run.error`, até 120 caracteres) |
| Aprovação pendente | Aprovação necessária | título da aprovação e da conversa |

Cancelamentos não geram aviso. O conteúdo das mensagens, comandos e detalhes de aprovação nunca entra no texto. Cada resultado de execução e cada aprovação são avisados uma vez; uma nova notificação da mesma conversa substitui a anterior (`tag`).

Clicar na notificação foca a janela e abre a conversa. Enquanto houver algo pendente em segundo plano, o título da aba recebe um contador, como `(1) Adelic`, que some quando a janela volta ao foco. O contador aparece mesmo com as notificações desligadas.

## Configuração

**Configurações › Agentes e respostas › Notificar quando terminar** (`settings.notifications`).

- Sem escolha explícita: ligado no aplicativo desktop, desligado no navegador.
- No navegador, ligar pede a permissão (`Notification.requestPermission()`). Se for negada, a opção continua desligada e a tela explica como liberá-la.

## Implementação

- Lógica em `src/hooks/useRunNotifications.ts`: funções puras (evento → aviso, regras de foco, deduplicação) e o hook que recebe os eventos de `/api/events` em `App.tsx`. Usa a Web Notification API, igual no navegador e no Electron.
- Desktop (`desktop/main.ts`, `permissionPolicy` em `desktop/policy.ts`): o Electron negava todas as permissões; agora só `notifications` é concedida, e só para a origem do próprio aplicativo. Câmera, área de transferência e o resto continuam negados.

## Limitações

- Não há preload nem IPC no desktop. O clique chama `window.focus()` no renderer, o que abre a conversa, mas o gerenciador de janelas pode não trazer a janela para a frente (prevenção de roubo de foco, comum no Wayland). Se for preciso, uma ponte IPC mínima (`focus`) fica para uma etapa seguinte.
- No desktop, a notificação depende do servidor de notificações da sessão (libnotify/D-Bus). Verificado localmente no Hyprland/Wayland: a permissão é concedida e a notificação é exibida.
- Os avisos só existem enquanto o Adelic está aberto; não há notificação push com a janela fechada.
