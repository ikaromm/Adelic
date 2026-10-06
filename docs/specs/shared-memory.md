# Memória local compartilhada

## Objetivo

Expor no Adelic a base existente do ai-memory usada por T3/Codex/outros clientes. Usar a mesma fonte; nenhuma cópia de notas para o SQLite do Adelic ou arquivos versionados. A tela Memória deve funcionar sem projeto de código selecionado. Escopos pessoais e de repositórios continuam separados; navegar na biblioteca não muda o escopo nem o contexto automático das conversas.

## Fonte e compatibilidade

Servidor MCP local existente: `http://127.0.0.1:49374/mcp`, ai-memory 2.1.0. Ferramentas reais: memory_query, memory_recent, memory_read_page, memory_write_page. Leituras de corpos e criação de notas passam pelo MCP com workspace/project explícitos. Edição de notas existentes usa o Markdown canônico local validado, preservando o cabeçalho completo conforme a correção descrita abaixo. O serviço não oferece listagem de escopos. Para o catálogo, consultar SOMENTE metadados no SQLite existente em modo readOnly (não criar arquivo nem escrever): `<AI_MEMORY_DATA_DIR ou ~/.local/share/ai-memory>/db/memory.sqlite`. Override específico ADELIC_MEMORY_DATA_DIR permitido para testes. Configurações com credenciais não são lidas. Erro de arquivo/schema incompatível deve ser claro, sem catálogo vazio que pareça sucesso.

Schema observado: workspaces(id,name), projects(id,workspace_id,name); pages(workspace_id,project_id,path,title,is_latest,expires_at,updated_at). IDs BLOB, join direto. Catálogo retorna workspace/project/pageCount de páginas latest não expiradas (expires_at INTEGER em microssegundos Unix; confirmar unidade com fixture). Listagem paginada de metadados por escopo, 50 por página, limite máximo 100, com total e offset. Nunca SELECT body/frontmatter nesse catálogo. Não esconder projetos além dos projetos cadastrados no Adelic; escopos vazios podem ser mostrados. Incluir default/_global como escopo existente de leitura, mas não implementar promoção automática a preferências globais. Busca de biblioteca deve restringir ao escopo escolhido, evitando união implícita com _global (usar scopes:[{workspace,project}] se necessário conforme capacidade MCP real).

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

## Correção de preservação em ai-memory 2.1.0

Teste real com nota sintética Fact mostrou que memory_write_page perde kind e outros campos que seu schema não aceita. Atualizações de notas existentes devem editar apenas o corpo do Markdown canônico local, preservando o prefixo YAML byte a byte; novas notas continuam criadas por MCP. O SQLite continua somente leitura. O serviço nativo observa o wiki e reindexa a alteração.

Validar /admin/status (data_dir real igual ao catálogo), proprietário local, UUIDs de escopo reais do catálogo e manifestos, caminhos regulares sem symlinks, corpo do arquivo igual à leitura MCP e versão atual antes da substituição. Gravar temporário no mesmo diretório com prefixo .ai-memory-tmp., permissões preservadas, fsync e rename. Divergência ou integração incompatível deve bloquear gravação, sem fallback para MCP que apaga metadados. Hash da versão inclui todo frontmatter estável e corpo.

Esta edição equivale a um editor local do mesmo usuário: não passa pelos admission hooks/RBAC/atribuição de autor do writer HTTP, não cria checkpoint Git nem preserva todos os contadores internos. Watcher atualiza índice de forma assíncrona. O controle de versão reduz conflitos, mas não fornece CAS atômico entre processos externos. Não representa escrita remota/multiusuário. Preservar frontmatter no disco e confirmar indexação com nota sintética antes do release.
