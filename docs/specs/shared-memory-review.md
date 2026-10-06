# Achados da validação inicial

Correções obrigatórias antes da entrega. Evidências locais de 2026-10-05, pela API/dev/preview do Adelic. Nenhuma nota pessoal foi editada.

## Backend (Luna)

- Busca explícita retornou HTTP 503: `scopes cannot be combined with workspace/project`. memory_query aceita scopes OU workspace/project. Para busca isolada, usar apenas scopes:[{workspace,project}], query e limite. Nunca mandar os dois formatos. Testar schema real com stub, incluindo ausência de _global fora do escopo escolhido.
- GET pages com somente workspace retorna 400 mas registra ERR_HTTP_HEADERS_SENT: helper responde erro e rota responde novamente. Validar uma vez, não enviar duas respostas. Falhas de catálogo/serviço são 503; entrada inválida é 400. Testar combinações inválidas/tipos/offset.
- Teste de catálogo ausente está consultando o banco REAL ao remover override. No host com ai-memory instalado, o teste falhou: expected function to throw. Todas as fixtures devem isolar ADELIC_MEMORY_DATA_DIR em diretório próprio mesmo nos testes de ausência/incompatibilidade. Restaurar o env prévio, não ler banco real em testes.
- memory_read_page real retorna {path,title,body,frontmatter:{pinned:true,tier:'working',tags:[...]}}. Frontmatter NÃO é YAML no corpo. A escrita precisa preservar pinned boolean, tier string, tags string[] e TTL a partir desse objeto (sem regex do body/strings). Hash de versão deve detectar mudança nesses metadados também. Testes MCP simulados precisam provar os argumentos efetivos e o resultado relido, erro de leitura diferente de not-found, criação em caminho existente e serialização/conflito local. Não ler notas privadas para testes.
- Schema REAL de memory_write_page: propriedades path:string, body:string, workspace:string, project:string, pinned:boolean, tier:string, tags:string[], expires_at:string|null (RFC3339). NÃO existe parâmetro frontmatter ou ttl. A leitura da nota QA confirmou frontmatter.expires_at='2026-11-01T00:00:00Z'. Escrever argumentos achatados {workspace,project,path,body,pinned:fm.pinned,tier:fm.tier,tags:fm.tags,expires_at:fm.expires_at}, filtrando apenas propriedades suportadas. Fixture MCP deve conter exatamente esse schema; não inventar frontmatter no write. Não mudar corpo nem tipo de metadados para contornar o schema.
- Não inventar scope _global no catálogo caso não exista. Nesta versão _global é leitura apenas na biblioteca (saves explícitos proibidos e ações UI desabilitadas), sem mudança/promover preferências globais por acidente. Ler global quando explicitamente selecionado é permitido.
- Simplificar duplicação de adapters mantendo API legado segura e compatível. Não alterar política de contexto/roteamento das conversas.

## Frontend (Luna, escopo separado)

- Astra reproduziu resultados do escopo A sobrevivendo ao selecionar B: limpar query aplicada, hits/listing e nota ao mudar escopo. Nunca exibir caminhos de A sob B nem ler nota homônima de B a partir de hit antigo. Leitura de openNote pendente precisa bloquear editor atual ou revalidar dirty/version na conclusão.
- Reprodução T3 real após a segunda implementação: abrir nota QA A, Editar sem alterar, atrasar GET da nota QA B via wrapper fetch; clicar B. Textarea de A continuou habilitado. Digitar RASCUNHO_DURANTE_LEITURA e liberar GET B apagou o rascunho e abriu B. É bloqueador confirmado, não hipótese. openNote deve iniciar busy/generation antes do await, desabilitar textarea/path/cancel/new/scope/trocas enquanto carrega e terminar busy em finally condicionado ao token. Save também deve incrementar generation ANTES da chamada para invalidar poll/refresh/open anteriores; gate na entrada contra save repetido e leitura em andamento. Editar precisa bloquear durante requests ou invalidar leituras. Testar na tela com fetch atrasado.
- Poll atual limpa hits por chamar loadList que faz setHits(null): uma busca desaparece em cinco segundos. Persistir busca aplicada e reexecutá-la no polling/refresh ou preservar resultados até novo submit. Separar texto digitado da busca aplicada.
- Poll deve atualizar catálogo/contagens/novos escopos. Uma única rodada em voo; descartar respostas antigas por scope/note/operação, também em search/save/paginação. Timer não deve reiniciar a cada resposta e nunca deve substituir draft começado depois da requisição. Guardas na resposta devem verificar dirty/editing/criação ATUAIS, não só valor capturado antes do await. Impedir trocas/cancelar/editar/nova nota enquanto save roda ou proteger com geração.
- Se manter componente montado, inicializar catálogo/lista somente na primeira visita à Memória. Hoje useEffect do componente oculto lê o catálogo ao abrir o chat; evitar leitura desnecessária no caminho simples. Reentrada deve atualizar imediatamente a fonte e preservar draft. Não reaplicar erro/sucesso de operação antiga no escopo atual.
- Ao sair de Memória para chat/atividade/configurações, hoje componente unmount perde draft; beforeunload não cobre navegação interna. Informar App sobre draft e bloquear navegação interna sem confirmação, ou manter componente montado com estado preservado, active false sem polling. Nenhuma perda silenciosa. Nova nota/cancel/open/scope idem. Descartar conscientemente via confirmação é permitido.
- HTTP409 de save deve virar conflito legível com ação recarregar, preservando draft; erro de serviço idem, sem loading eterno. Conflito não deve marcar leitura antiga como atual. Carregamento/vazio distinguíveis.
- Manter possibilidade de ajustar memoryWorkspace/memoryProject do projeto existente (foi removida da tela anterior); colocar seção em Configurações do projeto, independente do catálogo. Não trocar escopo de conversa ao navegar biblioteca.
- Preservar Markdown renderizado em leitura (ReactMarkdown/remarkGfm já usados), não mostrar todo corpo em pre monoespaçado. Labels acessíveis, tema escuro e 360px sem overflow.

## Runtime / testes delegados

Vitest falha com ENOENT ao criar SSR em /tmp dentro do runtime atual. Para executar testes nesta rodada sem expandir permissões: criar diretório temporário sob workspace ignorado .adelic/test-tmp e usar TMPDIR="$PWD/.adelic/test-tmp" npm test. Limpar somente temporários criados pelo próprio teste. Se não funcionar, relatar erro real; principal executará suíte no host. Não mudar sandbox para contornar erro nem afirmar testes aprovados sem resultado.

## Divisão e revisão

Backend em server/shared/tests memory; frontend em src e tests/ui-memory*. Sem sobreposição. Revisão Astra depois das correções, incluindo arquivos novos/untracked por leitura explícita. Principal integra, executa preview e instala somente após checks e fluxo bidirecional reais.

## Revisão final de preservação

O write achatado descrito na revisão inicial preservava somente campos anunciados e perdeu kind no teste real. A implementação final usa MCP apenas para criar e edita o corpo de notas existentes no wiki local, conforme shared-memory.md. Corrigidos: comparação de metadados entre MCP e snapshot, corpo iniciado por YAML em nota sem cabeçalho, symlinks reais/UID e código morto de metadados no caminho de criação. Testes direcionados finais: 19. Teste real confirmou Fact, campos personalizados, cabeçalho exato, conflito 409 e indexação nativa, somente em nota descartável.
