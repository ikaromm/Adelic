import { defineMessages } from '../../../shared/i18n';

// "Novo projeto" dialog (src/components/ProjectForm.tsx). The default memory workspace
// ("pessoal") is a real ai-memory scope name, so it stays as data.
export default defineMessages(
  {
    'projectForm.title': 'Novo projeto',
    'projectForm.detail': 'Conecte uma pasta do seu computador.',
    'projectForm.close': 'Fechar',
    'projectForm.name': 'Nome do projeto',
    'projectForm.namePlaceholder': 'Ex.: Meu aplicativo',
    'projectForm.path': 'Caminho da pasta',
    'projectForm.pathPlaceholder': '/home/voce/projetos/app',
    'projectForm.memoryScope': 'Escopo de memória explícito',
    'projectForm.workspace': 'Workspace',
    'projectForm.memoryProject': 'Projeto na memória',
    'projectForm.memoryProjectPlaceholder': 'identificador único',
    'projectForm.memoryProjectHint': 'O identificador começa pelo nome do projeto e pode ser ajustado.',
    'projectForm.permission': 'O agente usará esta pasta conforme a permissão definida.',
    'projectForm.cancel': 'Cancelar',
    'projectForm.create': 'Criar projeto',
  },
  {
    'projectForm.title': 'New project',
    'projectForm.detail': 'Connect a folder on your computer.',
    'projectForm.close': 'Close',
    'projectForm.name': 'Project name',
    'projectForm.namePlaceholder': 'E.g. My app',
    'projectForm.path': 'Folder path',
    'projectForm.pathPlaceholder': '/home/you/projects/app',
    'projectForm.memoryScope': 'Explicit memory scope',
    'projectForm.workspace': 'Workspace',
    'projectForm.memoryProject': 'Memory project',
    'projectForm.memoryProjectPlaceholder': 'unique identifier',
    'projectForm.memoryProjectHint': "The identifier starts from the project's name and can be adjusted.",
    'projectForm.permission': 'The agent will use this folder according to the permission set.',
    'projectForm.cancel': 'Cancel',
    'projectForm.create': 'Create project',
  },
);
