import { defineMessages } from '../../../shared/i18n';

// Conversation compaction: summary card, progress line and header menu (src/components/CompactionCard.tsx).
export default defineMessages(
  {
    'compaction.label': 'Resumo da conversa',
    'compaction.labelEarlier': 'Resumo anterior da conversa',
    'compaction.title': 'Resumo da conversa',
    'compaction.titleEarlier': 'Resumo anterior',
    'compaction.meta.autoLatest': 'Compactada automaticamente às {time} · as próximas mensagens partem deste resumo',
    'compaction.meta.autoEarlier': 'Compactada automaticamente às {time} · incluído no resumo seguinte',
    'compaction.meta.manualLatest': 'Compactada às {time} · as próximas mensagens partem deste resumo',
    'compaction.meta.manualEarlier': 'Compactada às {time} · incluído no resumo seguinte',
    'compaction.copy': 'Copiar resumo',
    'compaction.show': 'Ver resumo',
    'compaction.compacting': 'Compactando a conversa…',
    'compaction.actions': 'Ações da conversa',
    'compaction.waitRun': 'Aguarde a execução atual terminar',
    'compaction.compact': 'Compactar conversa',
    'compaction.compactHint': 'Resume a conversa; as próximas mensagens partem do resumo.',
  },
  {
    'compaction.label': 'Conversation summary',
    'compaction.labelEarlier': 'Earlier conversation summary',
    'compaction.title': 'Conversation summary',
    'compaction.titleEarlier': 'Earlier summary',
    'compaction.meta.autoLatest': 'Compacted automatically at {time} · new messages build on this summary',
    'compaction.meta.autoEarlier': 'Compacted automatically at {time} · included in the next summary',
    'compaction.meta.manualLatest': 'Compacted at {time} · new messages build on this summary',
    'compaction.meta.manualEarlier': 'Compacted at {time} · included in the next summary',
    'compaction.copy': 'Copy summary',
    'compaction.show': 'Show summary',
    'compaction.compacting': 'Compacting the conversation…',
    'compaction.actions': 'Conversation actions',
    'compaction.waitRun': 'Wait for the current run to finish',
    'compaction.compact': 'Compact conversation',
    'compaction.compactHint': 'Summarizes the conversation; new messages build on the summary.',
  },
);
