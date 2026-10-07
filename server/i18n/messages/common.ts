import { defineMessages } from '../../../shared/i18n.js';

// Messages shared by every route: the generic helpers in server/http/common.ts and server/index.ts.
export default defineMessages(
  {
    'common.notFound': 'Endpoint não encontrado',
    'common.invalidHost': 'Host inválido',
    'common.invalidOrigin': 'Origin inválido',
    'common.foreignOrigin': 'Origin externo bloqueado',
  },
  {
    'common.notFound': 'Endpoint not found',
    'common.invalidHost': 'Invalid host',
    'common.invalidOrigin': 'Invalid origin',
    'common.foreignOrigin': 'Foreign origin blocked',
  },
);
