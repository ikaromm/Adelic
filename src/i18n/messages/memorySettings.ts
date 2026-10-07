import { defineMessages } from '../../../shared/i18n';

// Settings › Memória: scope of detached conversations (src/components/DetachedMemorySetting.tsx)
// and how the composer shows it in a detached conversation.
export default defineMessages(
  {
    'memorySettings.detached.label': 'Memória das conversas avulsas',
    'memorySettings.detached.detail':
      'Escopo do ai-memory consultado por conversas sem projeto quando o pedido envolve memória. Só esse escopo é pesquisado.',
    'memorySettings.detached.off': 'Desligada',
    'memorySettings.detached.loading': 'Carregando escopos…',
    'memorySettings.detached.unavailable': 'Catálogo de memória indisponível: {error}',
    'memorySettings.detached.missing': '{scope} (não está no catálogo)',
    'memorySettings.detached.needsMemory': 'Ligue “Permitir busca de memória” para usar este escopo.',
    'memorySettings.composer.title': 'Projeto: {project} · Modo: {mode} · Memória: {scope}',
    'memorySettings.composer.context': 'Conversa avulsa: sem projeto; memória em {scope}.',
  },
  {
    'memorySettings.detached.label': 'Memory for standalone conversations',
    'memorySettings.detached.detail':
      'ai-memory scope searched by conversations without a project when the request involves memory. Only this scope is searched.',
    'memorySettings.detached.off': 'Off',
    'memorySettings.detached.loading': 'Loading scopes…',
    'memorySettings.detached.unavailable': 'Memory catalog unavailable: {error}',
    'memorySettings.detached.missing': '{scope} (not in the catalog)',
    'memorySettings.detached.needsMemory': 'Turn on “Allow memory search” to use this scope.',
    'memorySettings.composer.title': 'Project: {project} · Mode: {mode} · Memory: {scope}',
    'memorySettings.composer.context': 'Standalone conversation: no project; memory in {scope}.',
  },
);
