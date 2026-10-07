import { defineMessages } from '../../../shared/i18n';

// `@file` autocomplete in the composer (src/components/MentionPopup.tsx, src/hooks/useFileMentions.ts).
export default defineMessages(
  {
    'mentions.noProject': 'Escolha um projeto para mencionar arquivos',
    'mentions.loading': 'Buscando arquivos…',
    'mentions.empty': 'Nenhum arquivo encontrado',
    'mentions.error': 'Não foi possível listar os arquivos: {message}',
    'mentions.list': 'Arquivos do projeto',
  },
  {
    'mentions.noProject': 'Pick a project to mention files',
    'mentions.loading': 'Searching files…',
    'mentions.empty': 'No files found',
    'mentions.error': 'Couldn’t list the files: {message}',
    'mentions.list': 'Project files',
  },
);
