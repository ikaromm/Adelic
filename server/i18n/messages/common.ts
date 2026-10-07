import { defineMessages } from '../../../shared/i18n.js';

// Messages shared by every route: the generic helpers in server/http/common.ts and server/index.ts,
// and the not-found / invalid-request answers that many routes and services repeat.
export default defineMessages(
  {
    'common.notFound': 'Endpoint não encontrado',
    'common.invalidHost': 'Host inválido',
    'common.invalidOrigin': 'Origin inválido',
    'common.foreignOrigin': 'Origin externo bloqueado',
    'common.invalidJson': 'Corpo JSON inválido',
    'common.invalidParams': 'Parâmetros inválidos',
    'common.invalidRequest': 'Pedido inválido',
    'common.projectNotFound': 'Projeto não encontrado',
    'common.sessionNotFound': 'Conversa não encontrada',
    'common.runNotFound': 'Execução não encontrada',
    'common.modelNotAdvertised': 'Modelo não anunciado para este provedor',
    'common.shuttingDown': 'O Adelic está encerrando',
  },
  {
    'common.notFound': 'Endpoint not found',
    'common.invalidHost': 'Invalid host',
    'common.invalidOrigin': 'Invalid origin',
    'common.foreignOrigin': 'Foreign origin blocked',
    'common.invalidJson': 'Invalid JSON body',
    'common.invalidParams': 'Invalid parameters',
    'common.invalidRequest': 'Invalid request',
    'common.projectNotFound': 'Project not found',
    'common.sessionNotFound': 'Conversation not found',
    'common.runNotFound': 'Run not found',
    'common.modelNotAdvertised': 'Model not advertised by this provider',
    'common.shuttingDown': 'Adelic is shutting down',
  },
);
