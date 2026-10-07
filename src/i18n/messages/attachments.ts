import { defineMessages } from '../../../shared/i18n';

// Composer and message attachments (src/components/ComposerAttachments.tsx, src/hooks/useComposerAttachments.ts).
// Type and size checks come from shared/attachments.ts, which the server also uses (not converted here).
export default defineMessages(
  {
    'attachments.full': 'Limite de {max} anexos por mensagem',
    'attachments.attach': 'Anexar arquivos ou imagens',
    'attachments.pending': 'Anexos da mensagem',
    'attachments.uploading': 'Enviando…',
    'attachments.uploadingLabel': 'Enviando',
    'attachments.remove': 'Remover anexo {name}',
    'attachments.removeTitle': 'Remover',
    'attachments.sent': 'Anexos',
    'attachments.readFailed': 'Não foi possível ler “{name}”.',
    'attachments.tooMany.one': 'Cada mensagem aceita até {max} anexos; só cabem mais {count}.',
    'attachments.tooMany.other': 'Cada mensagem aceita até {max} anexos; só cabem mais {count}.',
    'attachments.noRoom': 'Cada mensagem aceita até {max} anexos; remova algum para anexar outro.',
  },
  {
    'attachments.full': 'Up to {max} attachments per message',
    'attachments.attach': 'Attach files or images',
    'attachments.pending': 'Message attachments',
    'attachments.uploading': 'Uploading…',
    'attachments.uploadingLabel': 'Uploading',
    'attachments.remove': 'Remove attachment {name}',
    'attachments.removeTitle': 'Remove',
    'attachments.sent': 'Attachments',
    'attachments.readFailed': 'Couldn’t read “{name}”.',
    'attachments.tooMany.one': 'Each message takes up to {max} attachments; only {count} more fits.',
    'attachments.tooMany.other': 'Each message takes up to {max} attachments; only {count} more fit.',
    'attachments.noRoom': 'Each message takes up to {max} attachments; remove one to attach another.',
  },
);
