# Design do aplicativo web local Adelic

React e TypeScript no frontend; Express e TypeScript no host. Vite roda como middleware do mesmo servidor na porta 4317 em desenvolvimento e gera dist para produção. SQLite nativo do Node persiste o estado. O código compartilhado em shared/contracts.ts é o contrato entre UI, API e adaptadores.

## Divisão de responsabilidades

- src/: UI, cliente HTTP e consumo de Server Sent Events. Recebe snapshots persistidos; streaming é reconciliado sem duplicar mensagens.
- server/index.ts: startup, validação de entrada/origin, API e assets.
- server/store.ts: SQLite, transações e recuperação de execuções interrompidas.
- server/router.ts: classificação determinística de Auto, contexto e ferramentas. Não chama provedor para decidir o modo.
- server/orchestrator.ts: uma execução por conversa, persistência, emissão de eventos, aprovação e cancelamento.
- server/memory.ts: cliente JSON-RPC MCP do ai-memory com timeouts e workspace/project explícitos; busca do caminho completo é feita apenas se configurada e relevante.
- server/providers/: adaptadores independentes, descoberta de binários, streaming, processos e políticas do runtime.

## API obrigatória

- GET /api/bootstrap retorna Bootstrap.
- POST /api/projects com {name,path,memoryWorkspace,memoryProject} retorna Project; o escopo explícito evita misturar notas entre projetos.
- PATCH /api/projects/:id permite atualizar nome e escopo de memória, com validação.
- POST /api/sessions com {projectId,providerId,model?,mode?,title?} retorna Session.
- GET /api/sessions/:id retorna SessionDetail.
- PATCH /api/sessions/:id permite title/providerId/model/mode, sem mudar configuração de uma execução ativa.
- DELETE /api/sessions/:id remove uma conversa ociosa e seus registros.
- POST /api/sessions/:id/messages com {content,clientMessageId?} retorna {runId,messageId}; HTTP 202. O resultado chega pelo SSE.
- POST /api/sessions/:id/cancel cancela execução ativa.
- POST /api/approvals/:id com {decision:'approve'|'deny'} responde aprovação da execução dona.
- GET /api/events é SSE global local: evento data contém StreamEvent; clientes refazem bootstrap/detail ao reconectar.
- PATCH /api/settings com campos de Settings retorna Settings.
- GET /api/memory/search?projectId=...&q=... retorna {hits:MemoryHit[]}.
- GET /api/memory/page?projectId=...&path=... retorna MemoryPage.
- POST /api/memory/page com {projectId,path,body} grava nota explícita.
- PATCH /api/skills/:id com {enabled} alterna skill disponível.
- GET /api/health retorna saúde local sem segredos.
- GET /api/export retorna dados próprios do aplicativo em JSON, sem credenciais nem wiki privada importada.

Erro HTTP tem {error:string}. ID desconhecido dá 404, conflito de execução dá 409, entrada inválida dá 400. Limitar corpo e tamanho de mensagem. Bloquear origins externos nas mutações; validar Host para mitigar rebinding. API não aceita comandos shell arbitrários nem binários fornecidos pelo browser.

## Roteamento e custo de contexto

Rápido: contexto recente até aproximadamente 6000 caracteres, esforço baixo, nenhuma consulta automática de memória e ferramentas restritas. Completo: orçamento maior (aproximadamente 24000), esforço alto, ferramentas do runtime com política explícita. Auto considera intenção (arquivos, pesquisa atual, código, comparação ampla, memória anterior), não somente tamanho. Uma pergunta longa puramente conceitual pode continuar rápida. Os limites controlam o envelope de histórico; não são uma garantia de tokens exatos.

Evitar carregar catálogo MCP ou toda a biblioteca de skills por turno. Codex app-server pode permanecer aquecido no backend; a descoberta de disponibilidade é cacheada. Usar instruções concisas e contexto recente limitado. Contexto de memória recuperado entra como dados não confiáveis, nunca instrução ou autorização.

Persistir mensagens e runs antes de responder ao browser. Se houver clientMessageId repetido, devolver a execução previamente aceita. Na falha do processo preservar conteúdo parcial e marcar resultado. Cancelamento resolve aprovações pendentes e encerra subprocessos donos. Não reexecutar ações automaticamente após reinício.

## Integração de agentes

ProviderRegistry em shared/contracts.ts especifica list, run, approve e shutdown. Cada run recebe AbortSignal e emite texto/status/ferramentas/aprovações/uso. Agentes anunciam capacidades reais. Encontrar binários diretos do mise antes dos wrappers que executam mise use a cada chamada; não alterar launchers globais. Autenticação continua no runtime, nunca no frontend.

Codex: JSON-RPC stdio com initialize/initialized, thread/start, turn/start e notificações. Gerenciar aprovações server-to-client e turn/interrupt. Claude: CLI com stream-json e contexto delimitado; modo rápido sem ferramentas/MCP adicional. Kiro: ACP com descoberta de capacidades e eventos. OpenCode: CLI/HTTP oficial, mantendo configuração existente. Runtime que não consegue oferecer política solicitada deve rejeitar claramente em vez de aceitar silenciosamente.

Estado implementado: Codex app-server é separado por diretório e política de ferramentas, com inicialização única por chave, interrupção e tratamento de encerramento inesperado. MCPs configurados são desativados no processo Adelic; o ai-memory é consultado pelo orquestrador em escopo explícito. Kiro usa perfil temporário com ferramentas explícitas, sem MCPs/recursos globais, e aceita as notificações ACP do CLI instalado. Claude tem adaptador implementado, pendente de autenticação e smoke real. OpenCode oferece apenas descoberta nesta entrega; execução é incremento futuro e aparece indisponível. Codex usa sandbox nativo; Kiro/Claude exigem bubblewrap para a política de escrita. Rede não é isolada.

## Aparência

Workspace claro com sidebar grafite, acento azul índigo discreto, tipografia de sistema refinada, espaçamento amplo, divisórias sutis e cards enxutos. Evitar aspecto genérico de painel com dezenas de badges. Estado inicial útil, sugestões de perguntas, seletor visível do caminho rápido/completo, toolbar compacta. Activity, Memória e Configurações são páginas funcionais. Responsivo a partir de 360px, navegação por teclado e labels acessíveis.
