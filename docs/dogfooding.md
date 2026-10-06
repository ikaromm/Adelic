# Validar o Adelic usando o Adelic

2026-10-05 — O usuário pediu projetos pequenos e mini fixes executados pelo aplicativo, começando pelo chat menos poluído e controles no rodapé.

## Primeiro caso implementado

Projeto Adelic real, conversa `Dogfood — chat limpo e controles no rodapé`. Pedidos enviados pelo preview T3 ao aplicativo Linux instalado, não por um CLI de modelo externo. Sol planejou dois escopos, Luna alterou JSX/CSS e Astra revisou. Correções seguintes também foram enviadas pelo Adelic como tarefas rápidas com ferramentas. O orquestrador externo escreveu a especificação, verificou os diffs, reproduziu problemas na tela, integrou documentação/versão e empacotou.

Astra encontrou Ajuda oculta e envio fora da janela baixa. O preview confirmou ambos; a primeira correção de altura não bastou. O teste de foco também detectou interação entre scroll-padding e scroll-margin que a revisão estática não encontrou. A matriz final de 192 combinações passou depois das correções. Isso confirma a necessidade de unir revisão estática e uso real, sem tratar a resposta do modelo como prova.

O executor relatou `ENOENT` na criação de um diretório SSR em `/tmp` ao tentar `npm test` no ambiente restrito. No host os 110 testes passam. A causa exata e uma solução para testes dentro do runtime permanecem pendentes; não foi ampliada a permissão para contornar o erro. A revisão com problemas terminou seu lifecycle como `completed`, mas a síntese declarou as pendências. O app ainda não distingue esse término de um veredito estruturado de aprovação.

## Próximos casos propostos

1. **Executar testes dentro do runtime:** reproduzir o problema de temporários em um projeto mínimo, oferecer um diretório temporário apropriado ao sandbox e comprovar que o teste roda pelo Adelic. Preservar dados operacionais fora do Git e os limites de escrita.
2. **Mini fix com teste falhando:** Node.js ou Python sem dependências externas, uma falha conhecida e teste que a reproduza. Registrar falha antes, diff restrito, teste passando depois e revisão independente. Repetir com Codex e Kiro para comparar capacidades e resultados.
3. **Projeto web pequeno:** lista de tarefas local com adicionar, concluir, filtrar e persistir. Validar erro de entrada, teclado, recarga e telas pequenas; implementar um ajuste real pela conversa vinculada e manter uma conversa avulsa independente.
4. **Robustez da execução:** negar uma aprovação, cancelar comando, reiniciar o desktop e retomar histórico. Medir o prazo até o subprocesso encerrar, além do estado cancelado na UI. No primeiro teste, o Python ainda existia na checagem imediata após cancelar e desapareceu após encerrar o backend; não foi estabelecido se houve atraso de cleanup ou término natural.

Antes de aumentar o número de agentes: registrar veredito de revisão separado do lifecycle, melhorar evidência de erro/resultado dos comandos e distinguir tempo de planejamento, execução e revisão. Um mini fix simples deve conseguir usar um executor; trabalho com arquivos dependentes pode usar plano e revisão. Medir chamadas e tempo por etapa, sem prometer uma latência fixa a partir de uma amostra.

## Evidências e limite

Contrato de UI em [composer-layout](specs/composer-layout.md); resultados, versão instalada e pacote em [validação](validation.md). Diffs anteriores foram preservados, arquivos e SQLite receberam backup local. Dados brutos, transcrições e backups ficaram fora do Git; não houve commit, push ou publicação. Os próximos casos acima são propostas, não projetos já executados.

## Segundo caso: memória compartilhada

Implementação pela instalação local do Adelic em 2026-10-05: planejamento Sol, executores GPT-6 Luna e revisão Astra. A biblioteca usa diretamente a fonte local ai-memory; catálogo SQLite somente leitura e corpos pelo MCP. A gravação inicial pelo MCP foi substituída para notas existentes após o achado abaixo. Não houve cópia de notas para dados do Adelic ou arquivos versionados. A base inicial continha 194 notas em 11 escopos; as 194 notas preexistentes mantiveram o mesmo conteúdo após a validação.

O preview T3 confirmou gravação pela tela lida pela CLI, alteração pela CLI refletida no polling da tela, preservação de pinned/tier/tags/expiração, conflito externo com rascunho preservado e gravação bloqueada, navegação interna sem perda de rascunho e editor bloqueado durante leitura atrasada de outra nota. A criação pela API legada também foi testada no MCP real. Respostas antigas receberam HTTP409; escrita global recebeu HTTP403. Entradas parciais/ambíguas e paginação inválida receberam HTTP400 sem resposta dupla. Notas sintéticas de QA foram removidas ao terminar.

Foram encontrados e corrigidos bugs de schema MCP, isolamento de escopo, criação legada, carregamento assíncrono, rascunhos e altura da biblioteca. Typecheck, build e 122 testes passaram no host. Testes MCP isolados cobrem falhas de serviço/permissão, catálogo ausente, criação após not-found exato, versões por metadados, serialização local e compatibilidade legada. O MCP não oferece compare-and-swap: há uma janela entre leitura e escrita por clientes diferentes; a checagem otimista e a fila local não garantem atomicidade entre aplicativos.

## Terceiro caso em desenvolvimento: thinking e aprovações

Implementação novamente enviada ao Adelic instalado, com executor GPT-6 Luna. Um turno falhou porque o modelo estava temporariamente sem capacidade; a repetição pelo aplicativo prosseguiu. Os primeiros testes encontraram níveis inventados quando faltava catálogo, adaptações delegadas incompatíveis e uma descoberta antecipada que atrasava a aceitação do modo Auto. As correções mantêm validação explícita antes da persistência para thinking manual, enquanto Auto descobre modelos durante a execução.

A revisão Sol encontrou o PATCH assíncrono segurando um snapshot antigo da sessão. Uma reprodução independente com catálogo atrasado confirmou a correção em três cenários: DELETE durante PATCH retorna 404 e não recria a conversa; outro PATCH retorna 409 e preserva a edição mais recente; início de turno retorna 409 e mantém activeRunId. Esta reprodução usou backend real com providers sintéticos e banco temporário, sem inferência ou dados pessoais.

A gravação pelo módulo de memória atualizado foi repetida contra ai-memory 2.1.0 real, que anuncia tipos nullable para workspace/project/tier. O corpo gravado foi lido pelo MCP e pinned/tier/tags foram preservados; a nota sintética foi removida.

Os menus e a política de comandos ainda precisam de integração e validação do runtime real; não são apresentados aqui como concluídos.

### Metadados completos: correção adicional

Uma nota sintética criada como Fact perdeu kind ao ser editada por memory_write_page de ai-memory 2.1.0. Os testes iniciais de pinned/tier/tags não cobriam esse campo ou campos personalizados. A integração passou a preservar o cabeçalho YAML byte a byte nas edições de corpo do wiki canônico local; criação de notas permanece no MCP. Nenhuma nota preexistente foi usada para reproduzir o defeito. Verificação de proprietário, identidade do serviço/escopo, arquivos regulares e divergências bloqueia escrita incompatível. Este caminho segue a edição local suportada por ai-memory; não oferece admission hooks, atribuição de autor, checkpoint Git ou CAS entre processos. O watcher nativo reindexa depois da alteração. A correção passou contra o serviço real: Fact e custom_qa preservados, cabeçalho byte a byte igual, corpo relido pelo MCP, save antigo recebeu 409 e busca encontrou o novo corpo pelo watcher nativo. Duas versões no banco confirmaram reindexação; a nota sintética foi removida e o total voltou a 194.

### Menus: revisão e fluxo rápido

Sol encontrou esforços extras omitidos por lista fixa, estado do provedor sobrevivendo à troca de conversa, foco fora dos popovers e rascunho global podendo ser enviado na conversa errada. Correções nativas pelo Adelic agora compartilham as regras de catálogo, mantêm drafts por sessão e enviam sandbox/approvalMode em uma atualização conjunta. Seis testes UI-thinking passaram. O preview confirmou draft A preservado após A→B→A e Kiro aberto no provedor correto com somente Auto.

Execução real no backend atualizado (antes da barreira externa final): Codex/GPT-6 Luna respondeu 4 para 2+2 em 5.271 ms, um worker/low, sem comandos/memória/grafo. A configuração untrusted foi aceita pelo app-server 0.160. Isso ainda não comprova os mounts da versão final. O cliente T3 apresentou erros em snapshot/press e cliques sem efeito; inspeção/eval e preenchimento permaneceram disponíveis. Geometria e handlers são verificados pelo DOM, sem afirmar teste de clique físico ou screenshot visual nessa rodada.

### Tela de memória depois da correção do escritor

Em 2026-10-05 (sessão UTC 2026-10-06), o preview T3 nativo abriu uma nota sintética no escopo de QA explícito. Entrada pelo preview_type e submissão do formulário via DOM salvaram `EDITADO_PELO_ADELIC`; ai-memory read-page leu o mesmo corpo. ai-memory write-page alterou somente a nota sintética, e o polling da tela apresentou `EDITADO_EXTERNAMENTE_2`. Com um rascunho aberto, outra edição externa apresentou conflito, manteve `RASCUNHO_PRESERVAR_3` e desabilitou Salvar. A nota de QA foi removida pela CLI. Não foram copiados conteúdos de notas pessoais para este documento. Captura e clique físico do preview continuam indisponíveis no cliente; esses resultados são de entrada literal, handlers DOM e API/CLI reais.

### Perfil Codex isolado: erro encontrado na execução real

A primeira pergunta real 2+2 depois do wrapper externo falhou antes de inferência, em 29ms: `invalid transport` na configuração de MCP. O adaptador criava overrides enabled=false para nomes da configuração original, mas o CODEX_HOME privado não tinha definições de transporte. Fixture real do executável 0.160 com HOME operacional sintético reproduziu a falha com `mcp_servers.ai-memory.enabled=false` e inicializou com `mcp_servers={}`. Não foi modificado login nem configuração real. Correção e nova inferência ainda pendentes no momento deste registro; o teste anterior de 2+2 bem-sucedido foi antes do wrapper e não valida este perfil.

### Menus após polimento

Preview T3 nativo: handlers DOM de abertura deram foco ao campo Buscar modelos ou à primeira escolha; Escape fechou e devolveu foco ao acionador. Fonte de labels medida: 12px. Em viewport de iframe do mesmo app de 360×320, os três painéis ficaram aproximadamente entre x=8–352 e y=8–312; document.scrollWidth=360 e Enviar permaneceu dentro da viewport com os menus fechados. Em 1280×800, o painel de thinking também ficou dentro da viewport. São medidas de layout/foco pelo DOM; captura, cliques físicos, Tab e resize do cliente nativo falharam e não estão declarados como testes concluídos.

### Respostas de Settings fora de ordem

Um teste com fetch controlado no preview nativo encaminhou PATCH de responseStyle e reteve sua resposta completa. A UI então salvou Escrita/Auto por outra fila, mostrou Escrita/Auto, e voltou a Leitura/Auto quando a resposta antiga foi liberada. A leitura real de `/api/export` mostrou workspace-write, comprovando a divergência. Foi usada somente a base clonada de QA; as configurações da clone foram restauradas para read-only/balanced/auto-safe. Correção por fila única e proteção de snapshots bootstrap está pendente de nova validação neste registro.

### Fechamento das corridas de configuração

Em 2026-10-06, o executor Luna corrigiu pelo Adelic a fila compartilhada de todas as alterações de Settings e a invalidação de snapshots antigos de bootstrap. Repetição pelo preview T3: resposta de responseStyle aplicada no servidor mas retida no cliente; alteração de sandbox solicitada pela tela de Configurações durante essa espera não foi enviada antes da primeira resposta. Enviar e Permissões permaneceram bloqueados. Liberada a resposta, a segunda alteração foi enviada e o rodapé mostrou Escrita · Auto, igual ao estado real da API. O teste usou somente a cópia operacional de QA e restaurou leitura/estilo balanceado.

### Inferência com o perfil Codex final

Depois de remover overrides MCP parciais, o perfil consulta a configuração efetiva antes de abrir cada thread e recusa MCPs nativos ativos ou não verificáveis. Inicialização/descoberta sem thread não inicia MCPs, comprovado com socket sintético e Codex 0.160 real. A pergunta 2+2 respondeu 4 em 2.310 ms, um executor Luna/low, sem comandos, memória ou grafo, com a barreira externa ativada. A consulta seguinte ao PC revelou que o protocolo novo anuncia environmentId local; o identificador precisa ser correlacionado ao ambiente da thread para a aprovação automática, em vez de assumir que um campo ausente significa local. Correção e nova consulta real são registradas no fechamento da release.

### Consulta ao PC, programa mínimo e negação reais

Em 2026-10-06, o backend atualizado executou uname -a em conversa avulsa Rápida com Codex/GPT-6 Luna: 5.418 ms, aprovação automática auditada, consulta real ao kernel, um executor e nenhuma memória/grafo. Não foi necessária confirmação humana. A identidade local foi validada pelo anúncio da mesma thread; ambientes ausentes, divergentes ou desconhecidos permanecem manuais.

Em projeto sintético separado, Luna criou hello.py e executou python3 hello.py: saída 42 em 5.664 ms. A composição com redirecionamento/encadeamento pediu confirmação e foi aprovada apenas para o teste. Depois rm keep.txt pediu confirmação, recebeu negação e a execução terminou em 5.189 ms; o arquivo sintético permaneceu byte a byte igual. Dados, prompts completos e saídas operacionais ficam fora do Git. Nenhum projeto do usuário foi alterado nesses testes.

A memória também passou pela falha de catálogo simulada no preview: erro 503 visível com lista preservada; liberado o serviço, Atualizar removeu o erro e manteve a lista. A troca Sol/Ultra→Luna ajustou thinking para Auto conforme o catálogo e apresentou aviso. Rascunho literal A permaneceu após trocar para Kiro, cujo rascunho estava vazio, e retornar a A.

O segundo cenário de Settings foi repetido: bootstrap real com snapshot balanceado ficou retido no cliente; a alteração de estilo para conciso recebeu ACK e apareceu na UI. Ao liberar o bootstrap antigo, a tela continuou concisa, igual ao servidor. O interceptor de QA foi removido e o estilo original restaurado.

### Encerramento do runtime e pacote final

O teste real inicialmente marcou cancelled mas deixou Python sintético vivo; o coordenador encerrou somente o PID de QA após conferir proprietário, cwd e argv. Luna corrigiu pelo Adelic para runtime exclusivo por chamada, cleanup idempotente e espera de kill/reap antes de resolver. A repetição final encerrou o filho em 105 ms e zerou pendências. Fixture com bubblewrap real verificou uma execução irmã preservada.

Com esse lifecycle, a repetição final de 2+2 respondeu 4 em 5.208 ms, um executor e sem ferramentas/memória/grafo; uname automático levou 3.992 ms. Programa mínimo e rm negado passaram novamente. São amostras com condições diferentes, sem atribuir toda a variação ao startup ou prometer tempo constante. Typecheck/build, 182 testes, pacote/smoke gráfico e instalação preservando histórico passaram. Evidência atual da v0.2.0 em docs/validation.md.
