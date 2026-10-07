import { defineMessages } from '../../../shared/i18n';

// Edit and resend a message, branch a conversation (src/components/EditBranch.tsx, src/hooks/useEditBranch.ts).
export default defineMessages(
  {
    'branch.edit': 'Editar',
    'branch.editTitle': 'Editar e reenviar',
    'branch.branch': 'Ramificar daqui',
    'branch.branchTitle': 'Ramificar daqui: nova conversa até esta mensagem',
    'branch.branchBusy': 'Aguarde a resposta terminar',
    'branch.input': 'Editar mensagem',
    'branch.attachments': 'Anexos da mensagem',
    'branch.removeAttachment': 'Remover anexo {name}',
    'branch.remove': 'Remover',
    'branch.confirm': 'Confirmar edição',
    'branch.confirmText.one':
      'Reenviar descarta a mensagem seguinte desta conversa. O agente recomeça com o histórico anterior a esta mensagem.',
    'branch.confirmText.other':
      'Reenviar descarta as {count} mensagens seguintes desta conversa. O agente recomeça com o histórico anterior a esta mensagem.',
    'branch.back': 'Voltar',
    'branch.discardResend': 'Descartar e reenviar',
    'branch.cancel': 'Cancelar',
    'branch.saveResend': 'Salvar e reenviar',
    'branch.originTitle': 'Abrir a conversa original: {title}',
    'branch.origin': 'Ramo de {title}',
    'branch.blocked.run': 'Aguarde a execução terminar ou cancele antes de editar',
    'branch.blocked.plan': 'Um plano está em execução; pare o plano antes de editar',
    'branch.blocked.busy': 'Aguarde a ação em andamento',
  },
  {
    'branch.edit': 'Edit',
    'branch.editTitle': 'Edit and resend',
    'branch.branch': 'Branch from here',
    'branch.branchTitle': 'Branch from here: new conversation up to this message',
    'branch.branchBusy': 'Wait for the answer to finish',
    'branch.input': 'Edit message',
    'branch.attachments': 'Message attachments',
    'branch.removeAttachment': 'Remove attachment {name}',
    'branch.remove': 'Remove',
    'branch.confirm': 'Confirm edit',
    'branch.confirmText.one':
      'Resending discards the next message in this conversation. The agent starts over from the history before this message.',
    'branch.confirmText.other':
      'Resending discards the next {count} messages in this conversation. The agent starts over from the history before this message.',
    'branch.back': 'Back',
    'branch.discardResend': 'Discard and resend',
    'branch.cancel': 'Cancel',
    'branch.saveResend': 'Save and resend',
    'branch.originTitle': 'Open the original conversation: {title}',
    'branch.origin': 'Branch of {title}',
    'branch.blocked.run': 'Wait for the run to finish or cancel it before editing',
    'branch.blocked.plan': 'A plan is running; stop it before editing',
    'branch.blocked.busy': 'Wait for the current action',
  },
);
