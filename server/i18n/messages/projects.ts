import { defineMessages } from '../../../shared/i18n.js';

// Projects, their hooks and file autocomplete (server/http/projects.ts, server/http/validation.ts).
// Keep pt-BR byte-identical.
export default defineMessages(
  {
    'projects.createRequired': 'name, path, memoryWorkspace e memoryProject são obrigatórios',
    'projects.invalidOrchestration': 'orchestration inválida',
    'projects.invalidGraphify': 'graphify inválido',
    'projects.pathRequired': 'path obrigatório',
    'projects.pathNotFolder': 'O caminho precisa ser uma pasta existente',
    'projects.listFilesFailed': 'Não foi possível listar os arquivos do projeto: {detail}',
    'projects.invalidHooks': 'Configuração de verificações inválida',
    'projects.taskNotFound': 'Tarefa não encontrada',
  },
  {
    'projects.createRequired': 'name, path, memoryWorkspace and memoryProject are required',
    'projects.invalidOrchestration': 'Invalid orchestration',
    'projects.invalidGraphify': 'Invalid graphify',
    'projects.pathRequired': 'path is required',
    'projects.pathNotFolder': 'The path must be an existing folder',
    'projects.listFilesFailed': 'Could not list the project files: {detail}',
    'projects.invalidHooks': 'Invalid checks configuration',
    'projects.taskNotFound': 'Task not found',
  },
);
