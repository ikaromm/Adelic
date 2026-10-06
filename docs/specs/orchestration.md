# Orquestrador como padrão por projeto

Decisão do usuário em 2026-10-04: cada projeto começa com um orquestrador que delega execução e mantém contexto enxuto, sabendo onde e o que precisa mudar. Aplica-se também aos projetos existentes que ainda não possuem configuração explícita.

## Comportamento

O agente/modelo escolhido na conversa é o coordenador. Configurações do projeto escolhem executor/revisor, com herança do provedor da conversa e seleção de modelos compatíveis descobertos. Orquestração começa ligada, com até dois executores concorrentes e revisão de trabalhos maiores. Pode ser desligada explicitamente para execução direta. Alterações de configuração valem para o próximo turno.

Perguntas simples são delegadas diretamente a um executor: uma chamada, esforço baixo por padrão, ferramentas locais disponíveis e nenhuma consulta automática de memória/grafo ou chamada de planejamento/síntese. O executor responde diretamente e pode consultar o computador quando precisar de evidências, inclusive em modo Rápido explícito. Disponibilidade de ferramentas não é registro de uso: eventos reais indicam quais ações ocorreram. Essa decisão do usuário em 2026-10-05 substitui a restrição inicial que desligava ferramentas nas perguntas rápidas. Inspeções pontuais também podem usar um executor. Pedidos maiores usam planejamento estruturado sem ferramentas, tarefas reais com escopos/dependências, revisão quando configurada e síntese. Plano inválido produz aviso e delegação de uma tarefa integral; não inventa execução bem-sucedida.

Executores recebem objetivo, instruções da tarefa, arquivos/escopo e contexto pertinente limitado, sem a transcrição completa do coordenador ou dos demais agentes. Coordenador recebe mapa limitado de caminhos, objetivo, resumos recentes e resultados compactos. Saídas detalhadas são guardadas por tarefa em SQLite, fora do histórico entregue ao coordenador. O mapa é um índice de caminhos, não uma leitura de todo o código.

Memória continua opcional e só é buscada quando a rota indicar contexto anterior. O recorte é tratado como dado não confiável, com falha ou ausência de notas informadas ao agente. Uma pergunta que precisa apenas de memória usa um executor, sem plano ou grafo. Skills habilitadas entram somente quando pertinentes a uma tarefa com ferramentas.

No máximo três executores conforme configuração; planos com mais etapas executam em lotes. Dependências são respeitadas. Escrita é serializada no projeto para evitar colisões; paralelismo inicial destina-se a tarefas de leitura. Escopo de tarefa é uma orientação ao executor, enquanto a política de escrita continua sendo imposta pelo sandbox do runtime. Nenhum agente pode elevar a permissão configurada.

Todos os agentes recebem o sinal de cancelamento do turno; aprovações pertencem ao mesmo turno e são encaminhadas ao runtime dono. Falhas, cancelamentos e reinícios preservam tarefas e resumos com o estado real. Contagens/tempos apresentados vêm de execuções, sem simulação.

## Contratos e tela

`OrchestrationConfig`, `DelegatedTask`, `ProjectBrief`, `ProjectCoordination` estão em `shared/contracts.ts`. Projetos antigos herdam `DEFAULT_ORCHESTRATION`; PATCH valida a configuração. GET `/api/projects/:id/coordination` retorna visão compacta e tarefas recentes. SessionDetail inclui metadados resumidos das tarefas da conversa; SSE `task` atualiza o acompanhamento. GET `/api/tasks/:id` carrega a saída completa de uma tarefa sob demanda, sem enviá-la no histórico inicial ou no SSE.

Configurações apresentam a orquestração do projeto, executores/revisores e limite de concorrência. Chat mostra quem está coordenando e tarefas delegadas com agente, estado e arquivos. A visão do projeto expõe o mapa e os resumos mantidos, para permitir inspeção do que efetivamente alimenta o coordenador.

## Graphify por projeto

Graphify começa ativado, inclusive nos projetos anteriores sem configuração explícita. Usa o CLI instalado: `graphify extract <projeto> --code-only --no-cluster --max-workers 2 --out <cache-do-projeto>`. Essa primeira integração faz extração AST de código, local e sem chamada de modelo; a camada semântica de documentos não está incluída. Não instala hooks, skills globais, servidor MCP adicional nem backend externo. Fonte da interface: [repositório oficial Graphify](https://github.com/Graphify-Labs/graphify), conferida também pelo CLI local.

Artefatos ficam em `~/.local/share/adelic/graphs/<hash-do-caminho>/graphify-out/graph.json`, com um registro local de atualização; `ADELIC_DATA_DIR` também muda essa base. O hash separa projetos e permite reaproveitar o índice de um mesmo diretório. Em tarefas com código, a primeira busca constrói o índice; buscas seguintes usam `graphify query <consulta> --graph <caminho> --budget 800`. O retorno é um recorte, tratado como contexto não confiável. Executores recebem também a instrução de consulta para buscar detalhes com as ferramentas do próprio runtime. Perguntas rápidas não constroem nem consultam o grafo.

O subprocesso de indexação/consulta recebe `GRAPHIFY_OUT` com caminho absoluto para manter também os caches auxiliares nessa pasta. Essa variável não altera o ambiente global do usuário.

Estado de atualização compara caminhos, tamanho e data de modificação dos arquivos, excluindo diretórios usuais de dependências, build e cache. Alterações detectadas causam nova extração pelo CLI. A verificação é conservadora: arquivos sem código também podem invalidar o índice, e árvores muito grandes podem aumentar o tempo dessa inspeção. Mudanças durante a construção/consulta invalidam o retorno: contexto desatualizado não é enviado como se fosse atual. Não há promessa de redução percentual de tokens sem benchmark; limite de saída e separação de contexto são verificáveis diretamente. Confirme arquivos antes de alterar, pois o grafo representa relações extraídas e inferidas pelo Graphify.

API: GET `/api/projects/:id/graphify` mostra estado, POST `/api/projects/:id/graphify/index` atualiza e POST `/api/projects/:id/graphify/query` com `{query}` consulta. PATCH do projeto aceita `{graphify:{enabled}}`. Ausência do CLI/erro aparece como tal e permite continuar a tarefa com leitura pontual. Graphify não dá permissões adicionais ao executor.

## Aceite

1. Projeto novo e projeto anterior sem configuração explícita têm orquestração ligada.
2. Pergunta simples cria uma tarefa real e faz somente uma chamada, com ferramentas locais disponíveis. Uma pergunta conceitual não deve consultar o computador sem necessidade; um diagnóstico deve conseguir executar consultas, respeitando sandbox e aprovações.
3. Trabalho maior planeja sem ferramentas, executa tarefas e sintetiza usando resumos limitados.
4. Tarefas independentes de leitura podem ser concorrentes; dependências e escrita não colidem.
5. Contexto de executor e coordenador é separado e limitado; saídas completas persistidas não entram automaticamente no prompt principal.
6. Cancelamento/falha/reinício e aprovações funcionam também nas tarefas delegadas.
7. Tela permite alterar as opções por projeto e acompanha estados reais.
