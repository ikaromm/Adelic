# Memória local compartilhada

## Objetivo

Expor no Adelic a base existente do ai-memory usada por T3/Codex/outros clientes. Usar a mesma fonte; nenhuma cópia de notas para o SQLite do Adelic ou arquivos versionados. A tela Memória deve funcionar sem projeto de código selecionado. Escopos pessoais e de repositórios continuam separados; navegar na biblioteca não muda o escopo nem o contexto automático das conversas.

## Fonte e compatibilidade

A biblioteca usa somente o serviço ai-memory, nunca os arquivos dele. Assim funciona igual com o serviço instalado no computador ou em Docker, onde o SQLite e o Markdown ficam no volume `ai-memory-data` (`/data` dentro do contêiner) e não são acessíveis ao usuário do Adelic.

- Endereço: `ADELIC_MEMORY_URL`, padrão `http://127.0.0.1:49374`. Só loopback (`127.0.0.1`, `localhost`, `::1`), sem credenciais, query ou fragmento na URL.
- Token: quando o serviço usa `AI_MEMORY_AUTH_TOKEN` (comum em Docker), informe o mesmo valor em `ADELIC_MEMORY_TOKEN` ou num arquivo em `ADELIC_MEMORY_TOKEN_FILE`. Se nenhum for informado, `AI_MEMORY_AUTH_TOKEN` do ambiente é usado. O Adelic lê `ADELIC_MEMORY_TOKEN` ao iniciar e o remove do ambiente, para que os agentes não o herdem. O token vai como `Authorization: Bearer` em todas as chamadas e nunca aparece em logs ou respostas.
- Capacidades usadas, verificadas no código e no binário do ai-memory 2.1.0 e 2.5.2 (a CI roda os testes de integração contra as duas versões):
  - MCP `/mcp`: `memory_query` (busca restrita a `scopes:[{workspace,project}]`), `memory_read_page` (corpo e frontmatter) e `memory_write_page` (criação).
  - API `/api/v1`, somente leitura: `GET /projects` lista escopos e contagens; `GET /workspaces/{w}/projects/{p}/pages` lista as notas atuais; `GET .../pages/{path}` confirma se um caminho existe. Essa API exige `serve --enable-web`; a imagem Docker oficial e o serviço systemd deste computador já usam essa opção.
  - `POST /admin/write-page`: reescreve notas existentes.
- O MCP não oferece listagem de escopos nem catálogo; a API `/api/v1` cumpre essa função. A paginação (50 por página, máximo 100) é feita no Adelic sobre a lista do serviço. As contagens são as do serviço: notas `is_latest`; notas com TTL vencido continuam até a próxima limpeza (sweep).
- Erros não viram catálogo vazio. Os casos tratados: serviço indisponível (503 com o endereço), token ausente ou errado (indica `ADELIC_MEMORY_TOKEN`), API ausente (indica `--enable-web`), escopo inexistente (404), resposta incompatível, e catálogo vazio enquanto `/admin/status` informa notas atuais.

Nenhuma nota é copiada para o banco do Adelic. A busca automática no chat continua separada (`memoryContextFor`, com o workspace/project do projeto vinculado) e a biblioteca não muda esse escopo.

## Contrato

Adicionar tipos MemoryScope {workspace,project}, MemoryScopeInfo extends MemoryScope {pageCount}, MemoryCatalog {scopes,totalPages}, MemoryListing {pages: MemoryHit[],total,offset,limit}; MemoryPage ganha version string opcional (hash da leitura). Manter APIs antigas com projectId para compatibilidade; adicionar workspace/project explícitos nas mesmas rotas (rejeitar escopo parcial ou combinação ambígua). GET /api/memory/catalog; GET /api/memory/pages?workspace=...&project=...&offset=0&limit=50; search/page suportam escopo independente. POST page aceita workspace/project/path/body e expectedVersion string para edição ou null para criação, rejeita conflito com HTTP 409. APIs antigas continuam usáveis; editor novo sempre envia expectedVersion. Validar strings/limites/caminhos .md, nenhuma travessia ou escrita fora do escopo.

O write MCP não tem compare-and-swap: comparar versão atual antes de escrever, serializar saves locais por escopo/path e informar limite de corrida com clientes externos. Não prometer atomicidade entre processos. Releitura pós-save deve devolver corpo efetivamente salvo/version; preservar pinned/tier/tags/expires_at existentes suportados pelo schema da ferramenta (frontmatter de memory_read_page). Nova nota não sobrescreve path existente silenciosamente. Não alterar a lógica de contextFor/roteador ou trazer todas as notas ao contexto.

## Interface

Componente MemoryPage separado para reduzir App.tsx, com catálogo/workspace/projeto independentes de projeto de código. Seleção inicial do escopo pessoal preferido quando disponível, senão primeiro disponível; lembrança localStorage permitida para nomes de escopo. Notas existentes aparecem ao abrir, sem busca obrigatória; contagem, busca, paginação, atualizar, nova nota, editar, salvar/cancelar. Indicar fonte compartilhada T3/Codex e isolamento de contexto em linguagem simples. UI escura, responsiva 360px, estados loading/vazio/indisponível/salvando/conflito. Remover antiga UI memória acoplada a selectedProject e código morto correspondente, mantendo configuração de escopo do projeto nas Configurações ou seção apropriada (não permitir que catálogo o altere implicitamente).

Atualização automática enquanto página visível, aproximadamente 5s, sem polling no chat ou aba oculta; atualizar lista/catalog e nota aberta sem edição. Proteger drafts ao trocar nota/escopo, sair da página, cancelar ou ao detectar mudança externa. Durante edição nunca substituir draft pelo polling; detectar versão externa e oferecer recarregar depois de confirmação explícita e impedir save até resolver conflito. Guardar respostas antigas por geração de escopo/nota; evitar respostas fora de ordem, requests simultâneos e polling apagando criação/draft. Falha externa deve exibir erro e preservar draft. Não esconder falhas atrás de 'conectada'.

## Divisão pelo Adelic

1. Executor Luna backend: shared/contracts.ts, server/memory.ts, server/memory-catalog.ts (novo), server/index.ts, tests/memory*.test.ts (novos). Não alterar src.
2. Executor Luna frontend após contrato backend: src/api.ts, src/MemoryPage.tsx (novo), src/App.tsx, src/styles.css, tests/ui-memory*.test.ts (novos se necessário). Não alterar server/shared.
3. Revisão Astra somente leitura; coordenador Sol integra. Não resetar alterações pré-existentes, alterar credenciais, publicar, instalar, executar git commit/push ou ler corpos privados para gerar fixtures. Especificação não é dado de memória.

## Validação

Testes com fixtures fora de notas reais: catálogo read-only/escopos distintos/expiração/paginação; MCP indisponível; metadata preservada; conflito e criação em path existente; parâmetros antigos/novos e paths inválidos. Executar typecheck, suite e build. Principal valida no preview T3: notas existentes visíveis sem projeto de código; nota de QA criada pelo MCP aparece sem reload; edição pelo Adelic é legível no MCP/CLI; atualização externa aparece automaticamente; draft e conflito não perdem trabalho. Limpar somente nota de QA criada para o teste. Atualizar documentação, pacote Linux e instalar preservando histórico após validação.

## Evidência de integração

Validação em 2026-10-05: catálogo real, roundtrip tela→CLI, CLI→polling, conflito/rascunho, metadados e compatibilidade legada. As notas preexistentes não foram alteradas. Typecheck/build e 122 testes passaram. Detalhes em `docs/dogfooding.md`. Não há transcrições ou corpos privados nos artefatos versionados.

## Edição de notas existentes

Até a v0.2.0, notas existentes eram editadas diretamente no Markdown local. Isso exigia acesso ao diretório de dados e não funcionava com Docker. Agora a edição passa pelo próprio serviço, que atualiza o índice, cria o checkpoint Git e executa os hooks de admissão.

Nenhum dos writers do serviço aceita frontmatter arbitrário. `/admin/write-page` reconstrói os metadados a partir de `title`, `kind`, `tier`, `tags` e `pinned`. `memory_write_page` reconstrói a partir de `title`, `tier`, `tags`, `pinned` e `expires_at`, mas não aceita `kind`. Nos dois casos, o servidor deriva `type`, `stale_after` e `generated`. Por isso, `server/memory-edit.ts` só permite editar quando um dos writers reproduz exatamente todos os campos da nota:

- Sem `expires_at`: usa `/admin/write-page`. Com `expires_at` e sem `kind`: usa `memory_write_page`.
- A edição é bloqueada antes de gravar (HTTP 422, com a explicação na tela) quando a nota tem:
  - campos que nenhum writer preserva;
  - `type` diferente do derivado;
  - `kind` junto com `expires_at`;
  - `tags: []`, `pinned: false` ou tier desconhecido;
  - `stale_after` diferente de `expires_at`.
- O conflito é detectado pela versão: hash do corpo e de todo o frontmatter. A versão é conferida no início e de novo logo antes de gravar. Saves do Adelic são serializados por escopo/caminho, e versão antiga retorna 409 preservando o rascunho.
- Depois de gravar, a nota é relida pelo MCP. O corpo precisa ser igual ao enviado; o filtro de segredos do serviço pode alterá-lo, e nesse caso é retornado 503. O frontmatter também precisa bater, exceto `generated.at`, que o serviço atualiza. `last_modified_by` também é renovado pelo serviço quando há autenticação de usuário.
- Criação continua via `memory_write_page`. Caminho já existente no serviço retorna 409, mesmo que o arquivo da nota esteja ausente.

Limites (propostas de correção em [propostas ao ai-memory](ai-memory-proposals.md)): o serviço não oferece compare-and-swap entre processos. Uma alteração externa entre a última conferência e a gravação ainda pode ser sobrescrita; a janela é pequena, mas existe. Notas com metadados personalizados escritos por outros clientes ficam somente leitura no Adelic até haver um writer que preserve frontmatter completo.
