import { defineMessages } from '../../../shared/i18n.js';

// Memory browser and editor (server/http/memory.ts, server/memory.ts, server/memory-service.ts).
// Low-level diagnostics of the ai-memory contract (tool schemas, frontmatter checks) and the
// service's own error text stay as they are. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'memory.scopeTogether': 'Informe workspace e project juntos, sem projectId',
    'memory.invalidScope': 'Escopo inválido',
    'memory.invalidProjectId': 'projectId inválido',
    'memory.scopeRequired': 'workspace/project ou projectId são obrigatórios',
    'memory.searchRequired': 'projectId ou workspace/project e q são obrigatórios',
    'memory.pageRequired': 'projectId ou workspace/project e path são obrigatórios',
    'memory.invalidPath': 'path inválido',
    'memory.legacyWriteRequired': 'projectId, path e body (máximo 50000 caracteres) são obrigatórios',
    'memory.globalReadOnly': 'Escrita no escopo _global não permitida',
    'memory.writeRequired': 'workspace, project, path, body e expectedVersion (string ou null) obrigatórios',
    'memory.pathExists': 'Já existe uma nota nesse caminho; recarregue antes de editar',
    'memory.changedSinceRead': 'A nota foi alterada desde a leitura; recarregue antes de salvar',
    'memory.changedDuringEdit': 'A nota ou seus metadados foram alterados durante a edição; recarregue antes de salvar',
    'memory.bodyNotConfirmed':
      'O ai-memory não confirmou o corpo salvo (o serviço pode ter alterado o texto, por exemplo ao remover dados sensíveis); recarregue a nota',
    'memory.metadataDiffer':
      'O ai-memory salvou a nota, mas os metadados lidos depois diferem dos anteriores; confira a nota antes de editar de novo',
    'memory.createNotConfirmed': 'O MCP não confirmou o corpo recém-criado',
    'memory.mcpDenied':
      'O MCP do ai-memory recusou o acesso (HTTP {status}). Se o serviço usa AI_MEMORY_AUTH_TOKEN, informe o mesmo token ao Adelic em ADELIC_MEMORY_TOKEN ou ADELIC_MEMORY_TOKEN_FILE.',
    'memory.httpStatus': 'ai-memory respondeu HTTP {status}',
    'memory.notJson': 'Resposta do MCP do ai-memory não é JSON',
    'memory.noScope': 'Projeto sem escopo de memória configurado',
    'memory.unavailable': 'Serviço ai-memory indisponível em {url}: {reason}',
    'memory.timeout': 'Serviço ai-memory indisponível em {url}: sem resposta em {ms} ms',
    'memory.serviceDenied':
      'O ai-memory recusou o acesso a {route} (HTTP {status}). Se o serviço usa AI_MEMORY_AUTH_TOKEN, informe o mesmo token ao Adelic em ADELIC_MEMORY_TOKEN ou ADELIC_MEMORY_TOKEN_FILE.',
  },
  {
    'memory.scopeTogether': 'Send workspace and project together, without projectId',
    'memory.invalidScope': 'Invalid scope',
    'memory.invalidProjectId': 'Invalid projectId',
    'memory.scopeRequired': 'workspace/project or projectId is required',
    'memory.searchRequired': 'projectId or workspace/project, and q, are required',
    'memory.pageRequired': 'projectId or workspace/project, and path, are required',
    'memory.invalidPath': 'Invalid path',
    'memory.legacyWriteRequired': 'projectId, path and body (at most 50000 characters) are required',
    'memory.globalReadOnly': 'Writing to the _global scope is not allowed',
    'memory.writeRequired': 'workspace, project, path, body and expectedVersion (string or null) are required',
    'memory.pathExists': 'A note already exists at this path; reload before editing',
    'memory.changedSinceRead': 'The note changed since it was read; reload before saving',
    'memory.changedDuringEdit': 'The note or its metadata changed during the edit; reload before saving',
    'memory.bodyNotConfirmed':
      'ai-memory did not confirm the saved body (the service may have changed the text, for example by removing sensitive data); reload the note',
    'memory.metadataDiffer':
      'ai-memory saved the note, but the metadata read afterwards differs from before; check the note before editing again',
    'memory.createNotConfirmed': 'The MCP did not confirm the newly created body',
    'memory.mcpDenied':
      'The ai-memory MCP denied access (HTTP {status}). If the service uses AI_MEMORY_AUTH_TOKEN, give Adelic the same token in ADELIC_MEMORY_TOKEN or ADELIC_MEMORY_TOKEN_FILE.',
    'memory.httpStatus': 'ai-memory answered HTTP {status}',
    'memory.notJson': 'The ai-memory MCP response is not JSON',
    'memory.noScope': 'Project has no memory scope configured',
    'memory.unavailable': 'ai-memory service unavailable at {url}: {reason}',
    'memory.timeout': 'ai-memory service unavailable at {url}: no answer in {ms} ms',
    'memory.serviceDenied':
      'ai-memory denied access to {route} (HTTP {status}). If the service uses AI_MEMORY_AUTH_TOKEN, give Adelic the same token in ADELIC_MEMORY_TOKEN or ADELIC_MEMORY_TOKEN_FILE.',
  },
);
