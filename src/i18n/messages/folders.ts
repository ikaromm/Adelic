import { defineMessages } from '../../../shared/i18n';

// Virtual project folders and archive controls in the conversation sidebar.
export default defineMessages(
  {
    'folders.tree': 'Pastas e conversas do projeto',
    'folders.title': 'Pastas virtuais',
    'folders.createRoot': 'Criar pasta no projeto',
    'folders.createChild': 'Criar subpasta em {name}',
    'folders.create': 'Criar pasta',
    'folders.name': 'Nome da pasta',
    'folders.namePlaceholder': 'Nome da pasta',
    'folders.rename': 'Renomear pasta',
    'folders.renameNamed': 'Renomear {name}',
    'folders.saveRename': 'Salvar nome da pasta',
    'folders.deleteNamed': 'Excluir pasta {name}',
    'folders.deleteConfirm':
      'Excluir a pasta “{name}”? As conversas serão movidas para a pasta superior ou para a raiz do projeto. Nenhum dado do projeto será apagado.',
    'folders.deleteHasChildren': 'Remova as subpastas antes de excluir esta pasta.',
    'folders.deleteRunning': 'Espere a execução terminar antes de excluir esta pasta.',
    'folders.move': 'Mover conversa para uma pasta',
    'folders.projectRoot': 'Conversas na raiz do projeto',
  },
  {
    'folders.tree': 'Project folders and conversations',
    'folders.title': 'Virtual folders',
    'folders.createRoot': 'Create project folder',
    'folders.createChild': 'Create subfolder in {name}',
    'folders.create': 'Create folder',
    'folders.name': 'Folder name',
    'folders.namePlaceholder': 'Folder name',
    'folders.rename': 'Rename folder',
    'folders.renameNamed': 'Rename {name}',
    'folders.saveRename': 'Save folder name',
    'folders.deleteNamed': 'Delete folder {name}',
    'folders.deleteConfirm':
      'Delete the “{name}” folder? Conversations will move to its parent folder or the project root. No project data will be deleted.',
    'folders.deleteHasChildren': 'Remove subfolders before deleting this folder.',
    'folders.deleteRunning': 'Wait for the conversation run to finish before deleting this folder.',
    'folders.move': 'Move conversation to a folder',
    'folders.projectRoot': 'Project root conversations',
  },
);
