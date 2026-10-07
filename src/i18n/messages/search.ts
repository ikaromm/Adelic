import { defineMessages } from '../../../shared/i18n';

// Conversation search dialog (src/components/ConversationSearch.tsx).
export default defineMessages(
  {
    'search.title': 'Buscar nas conversas',
    'search.close': 'Fechar busca',
    'search.placeholder': 'Palavras em títulos e mensagens…',
    'search.results': 'Resultados',
    'search.empty': 'Nada encontrado para “{query}”.',
    'search.role.user': 'Você',
    'search.role.assistant': 'Agente',
    'search.role.system': 'Sistema',
    'search.match': '{role}:',
    'search.hint': 'A busca roda neste computador. {enter} abre o primeiro resultado.',
  },
  {
    'search.title': 'Search conversations',
    'search.close': 'Close search',
    'search.placeholder': 'Words in titles and messages…',
    'search.results': 'Results',
    'search.empty': 'Nothing found for “{query}”.',
    'search.role.user': 'You',
    'search.role.assistant': 'Agent',
    'search.role.system': 'System',
    'search.match': '{role}:',
    'search.hint': 'Search runs on this computer. {enter} opens the first result.',
  },
);
