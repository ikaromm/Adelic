import { defineMessages } from '../../../shared/i18n';

// System notifications for finished runs and pending approvals (src/hooks/useRunNotifications.ts).
export default defineMessages(
  {
    'notifications.conversation': 'Conversa',
    'notifications.compacted': 'Conversa compactada',
    'notifications.ready': 'Resposta pronta',
    'notifications.failed': 'Execução falhou',
    'notifications.failedBody': '{conversation}: {reason}',
    'notifications.noReason': 'erro não informado',
    'notifications.approval': 'Aprovação necessária',
    'notifications.approvalBody': '{title} · {conversation}',
  },
  {
    'notifications.conversation': 'Conversation',
    'notifications.compacted': 'Conversation compacted',
    'notifications.ready': 'Answer ready',
    'notifications.failed': 'Run failed',
    'notifications.failedBody': '{conversation}: {reason}',
    'notifications.noReason': 'unspecified error',
    'notifications.approval': 'Approval needed',
    'notifications.approvalBody': '{title} · {conversation}',
  },
);
