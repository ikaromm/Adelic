# Roadmap de qualidade e eficiência da harness Adelic

Estado: proposta revisada para execução. Data: 15 de outubro de 2026. Base investigada: `f1d64c4`, versão 0.5.4. Revisão crítica por Luna, Sol e Astra; bloqueadores do documento resolvidos.

O objetivo é aumentar a quantidade de tarefas de engenharia resolvidas corretamente dentro de um orçamento previsível. O SWE-bench será um instrumento de avaliação, junto de jornadas gerais do Adelic. Corrigir apenas os exemplos conhecidos ou terminar uma execução mais rápido sem resolver a tarefa não satisfaz esse objetivo.

## Evidências que orientam o trabalho

| Medição | Aprovação oficial | Tempo acumulado |
| --- | --- | --- |
| Codex histórico, seleção de dez tarefas | 9/10 | 17,42 min |
| Adelic original, mesma seleção | 4/10 | 38,87 min |
| Adelic v4, reteste da seleção conhecida | 6/10 | 49,92 min |

O ganho líquido do reteste v4 inclui uma regressão de uma tarefa de pytest que passava anteriormente. Uma tentativa por configuração e tarefa, casos conhecidos e comparação com um Codex histórico não estabelecem desempenho geral nem causalidade.

No diagnóstico mais recente de `django__django-15629`, o Adelic levou 538,825 s e passou 1/2 testes de correção e 115/115 regressões. O reteste anterior levou 353,021 s com a mesma contagem de aprovação; o Codex histórico resolveu a tarefa em 183,583 s. O candidato executou reparo e segunda revisão, sem completar a correção.

| Fase do diagnóstico recente | Tempo |
| --- | --- |
| Planejamento | 11,190 s |
| Implementação inicial | 173,880 s |
| Primeira revisão | 115,080 s |
| Reparo | 91,875 s |
| Segunda revisão | 109,495 s |
| Síntese | 20,610 s |

As fases somaram 522,130 s; o restante da duração foi 16,695 s. As 132 ferramentas observadas consumiram 16,388 s dentro dessas fases, não em adição a elas. Revisões ocuparam 41,7% do tempo total. O custo de interação com ferramentas pode provocar novas inferências e contexto, portanto a baixa duração das ferramentas não elimina problemas de interface.

Problemas observados que justificam intervenções:

- O reparo recebeu um escopo de dois arquivos, embora seu relato identificasse um terceiro backend necessário dentro da área prevista no trabalho original. Uma tentativa nesse terceiro arquivo também falhou por leitura incompleta. Contrato de escopo e uso da ferramenta precisam ser isolados na reprodução.
- Cada fase começa uma thread Codex nova. O reparo cria outra execução e worktree; o relato anterior não equivale à continuidade da sessão.
- Oito invocações de testes locais apareceram no trace, sete com saída zero após a primeira falha, mas o índice estruturado de checks ficou vazio. Isso não comprova MySQL nem equivalência entre código testado na worktree e código integrado.
- O inventário global de artefatos permaneceu incompleto apesar da integração Git aplicada. Existe evidência localizada de integração, mas ela não é uma identidade completa do projeto.
- Dez respostas de erro de ferramenta incluíram paginação sem revisão, busca em arquivo onde se esperava diretório, duas edições rejeitadas e um arquivo inexistente. Nem todo erro é defeito da harness.
- Sol direto e Luna direto resolveram um caso em que a configuração coordenada integralmente Sol falhou. Atribuir o problema apenas ao Luna não é sustentado; contexto, worktree e fases também diferiam.

## Limites e decisões de arquitetura

As implementações devem estender os componentes existentes: `orchestrator.ts`, `coordination.ts`, `worktrees.ts` e suas primitivas de snapshot, `checkpoints.ts`, `hooks.ts`, `check-source.ts`, `run-evidence.ts` e o provider Codex. Reutilizar também os scripts `benchmark-harness.mjs`, `benchmark-usage.mjs` e `benchmark-journeys.mjs` onde seus contratos servirem; eles não são drivers SWE intercambiáveis sem adaptação. Confirmar os caminhos e contratos na abertura de cada entrega.

Já existem pedido completo no worker, instruções de reprodução e regressão, handoff limitado, revisão estruturada, um reparo e até duas revisões. Não recriar esses recursos como novos subsistemas. O handoff recente tinha 617 caracteres completos: aumentar o limite não recupera informação que não foi registrada.

Permanecem o bind local por padrão, as políticas de aprovação, o isolamento verificado, a separação entre projetos e a distinção entre processo concluído, integração aplicada e objetivo resolvido. Findings, resumos e caminhos propostos pelo modelo são dados, não concessões de permissão. Nenhum resultado `unknown` será convertido em confirmação por conveniência.

O padrão de orquestração por projeto será preservado durante os experimentos. Mudanças de padrão exigem evidência além dos casos usados no desenvolvimento. Avaliação oculta e patches de referência não entram no contexto dos agentes.

## Sequência de entregas

| Entrega | Prioridade | Dependência | Dimensão | Situação |
| --- | --- | --- | --- | --- |
| R0a Protocolo e medição mínima | P0 | Nenhuma | Pequena | Contadores integrados; protocolo operacional em validação |
| R0b Checkpoints imutáveis por fase | P1 | R0a; ensaio de captura | Média a grande | Condicionada à necessidade de atribuição |
| R1 Escopo de correção separado da localização do finding | P1 | R0a e reprodução determinística | Média | Handoff adaptado; autorização estruturada ainda pendente |
| R2 Evidência localizada de integração para revisão | P1 | R0b | Média | Planejada |
| R3a Aplicabilidade e requisitos de checks | P1 | R0a | Média | Implementação em validação |
| R3b Canal explícito para checks do agente | P1 | R3a; contrato de execução/evidência | Média | Planejada |
| R4 Revisão após reparo orientada pelo delta | P2 | R2 e R3a; R3b quando houver checks do agente | Média | Condicionada à medição |
| R5 Continuidade do worker dentro do Run | P2 | R0a; decisão após R1 a R4 | Grande | Ensaio condicionado |
| R6 Redução de fases e atritos de ferramentas | P2 | R0a; categorias de erro verificadas | Pequena a média por hipótese | Condicionada à medição |
| R7 Roteamento de modelos e delegação especializada | P3 | Ganhos e limites das etapas anteriores | Média | Pesquisa posterior |
| R8 Validação em casos reservados e promoção | Gate | Cada candidato estável | Avaliação gradual | Obrigatória antes de mudar padrões |

Dimensão indica complexidade relativa, não previsão de prazo ou de ganho. Uma entrega pode produzir decisão de não implementar a hipótese seguinte. Não executar toda a lista automaticamente como se cada mudança já tivesse benefício demonstrado.

### R0a Protocolo e medição mínima

Reutilizar `providerAttempts`, observações, eventos, fixtures e integração existentes para construir uma linha de base reproduzível, sem criar uma suíte paralela. Registrar versão do código e CLI, modelos e esforço efetivos, prompts/configuração identificados por hash, superfície de ferramentas, runtime, isolamento, preparação e orçamento. Evitar nova plataforma de observabilidade. O manifesto também fixa quantidade de pares, repetições, ordem, critérios de invalidação, teto da campanha e regra de interrupção de R8.

Aceite: um início e um término por tentativa, término efetivamente confirmado, contabilização de falhas/cancelamentos, controles positivo e negativo válidos, e reconciliação das durações sem somar ferramentas duas vezes. Fixtures sem inferência verificam ausência de ferramentas, patch vazio, falha de integração e término sem atividade residual.

Decisão de saída: classificar se a próxima intervenção trata capacidade, escopo, integração, correção, revisão, ambiente ou apenas latência. Uma reprodução determinística pode justificar R1 sem construir primeiro avaliação oficial de todos os checkpoints.

### R0b Checkpoints imutáveis por fase

Ensaiar as primitivas existentes antes de escolher o formato. Preservar, antes da limpeza, a saída do worker inicial, o checkout após sua integração, a saída do worker de reparo, o checkout após sua integração e o patch final efetivamente submetido. Pontos idênticos podem compartilhar conteúdo por hash, preservando eventos distintos. O resultado principal pertence somente ao patch final, inclusive em timeout/cancelamento conforme protocolo predefinido.

A evidência precisa identificar escopo e baseline, resultado, delta completo ou referências protegidas contra coleta, origem, captura e limites. Não confundir identidade do filesystem observado com cópia integral de seu conteúdo. Reutilizar `checkpoints.ts` e snapshots das worktrees sem alterar HEAD/index do usuário. A captura entra no tempo medido; preparação e avaliação externa são registradas separadamente.

Armazenar conteúdo operacional fora dos arquivos versionados, com acesso limitado ao Run/projeto, permissões privadas e leitura paginada. Ponto de partida para o ensaio: delta de até 8 MiB, até 128 MiB por Run e 1 GiB por campanha, mínimo de 2 GiB livres e retenção automática de sete dias para capturas descartáveis. Confirmar compatibilidade desses limites com os mecanismos existentes e fixá-los no manifesto antes da execução; podem ser reduzidos ou alterados em outro ensaio identificado, nunca silenciosamente no meio da medição. Evidências históricas já existentes não entram nessa limpeza automática. Truncamento, falta de espaço e falha de captura permanecem explícitos; conteúdo parcial não prova delta completo. A captura não bloqueia indefinidamente o prazo original. Nova persistência SQLite exige migração nova.

Avaliar checkpoints somente depois que toda a run terminar, sem retornar notas ou logs ocultos ao solver. Não escolher retroativamente o melhor patch como entrega. Aceite: atribuir reparo sem efeito, perda na segunda integração e regressão no reparo; preservar reprodução após limpeza da worktree, reinício e coleta de objetos Git. Se a captura não puder ser completa, não usá-la para provar equivalência do patch.

### R1 Escopo de correção separado da localização do finding

O campo `finding.file` continua localizando o relato. A correção deve conseguir confirmar quais arquivos de implementação e testes são necessários ao defeito, dentro do objetivo e da autoridade originais. Esses arquivos podem incluir um arquivo ainda não alterado pelo worker.

Separar localização do finding, evidência observada de alteração e permissão de edição. A evidência de que A mudou não prova que B mudou, mas uma tarefa pode autorizar corrigir B sem alegar alteração prévia. O registro de autoridade é produzido pelo servidor a partir do envelope efetivamente autorizado da tarefa: projeto/raiz canônica, sandbox, política de aprovação e restrições explícitas já estabelecidas pelo usuário. Identificar origem e vínculo com Run/tarefa. Caminhos e justificativas propostos pelo modelo não criam esse envelope.

Restrições explícitas do usuário têm precedência; limites efetivos do runtime continuam obrigatórios. `planned.scope` orienta trabalho e concorrência, mas não concede permissão superior ao pedido. O reparo pode reutilizar o envelope original mantendo os findings como objetivo limitado. Se houver proibição explícita ou limite de escrita mais estreito, preservá-lo; quando a interpretação necessária não puder ser confirmada, manter a pendência em vez de inventar uma autoridade semântica automática. Registrar os arquivos propostos, a razão da ampliação mínima e o resultado de sua validação separadamente da autorização.

Estender o contrato existente antes de introduzir outro planejador ou chamada de modelo. Preservar os guards de identidade, caminhos, permissões, orçamento e lote de findings. Se não for possível confirmar o escopo necessário, registrar a razão específica e manter a pendência.

Aceite: fixture genérica em que o defeito é relatado em A e exige B e seu teste, todos dentro do envelope original, mesmo com B ainda não alterado. Cobrir proibição explícita de editar B, diretório autorizado sem lista de arquivos, arquivo novo/removido e múltiplos workers com fronteiras distintas. Bloquear um C arbitrário fora de uma restrição explícita, inclusive dentro da raiz, sem alegar que a harness prova automaticamente a relevância de todo caminho permitido. Uma fixture separada cobre a rejeição da edição por revisão ausente, sem confundi-la com escopo.

Avaliação real: uma tarefa conhecida serve de sentinela; o benefício precisa aparecer depois em outra tarefa ou jornada. Aprovação do caso conhecido não autoriza por si só mudança global.

### R2 Evidência localizada de integração para revisão

Consumir os checkpoints/deltas preservados por R0b na fronteira de `integrateExecutorWorktree`. O retorno atual contém apenas `changed`, `alreadyApplied` e `files`: não presumir que já devolve um patch durável ou baseline recuperável. A retenção antes da limpeza pertence a R0b; R2 implementa somente o índice, a autorização de consulta, a paginação e os metadados para expor essa mesma evidência em `runEvidence`, sem segunda captura ou outro protocolo de snapshot. Incluir identidade de baseline/resultado e origem. Diferenciar alterações preexistentes, contribuição integrada, delta já aplicado e estado atual do checkout. O diff atual isolado não reconstrói contribuição histórica.

O índice é um mapa de navegação. Não completa `Run.artifacts`, não prova autoria exclusiva ou diferença líquida final e não substitui a identidade de fonte exigida para aprovar ou limpar findings. Remoções, renomeações, caminhos literais e baseline suja precisam preservar suas semânticas.

Aceite: com inventário global incompleto, o reviewer consegue localizar e conferir o delta correto sem inventar lista global completa. Fixtures cobrem baseline suja, contribuição já aplicada, conflito, remoção, mudanças concorrentes e consulta após remover a worktree, reiniciar e coletar objetos Git. Nenhuma integração bloqueada produz evidência de integração aplicada. Aplicar os limites privados de armazenamento e acesso de R0b.

Medição: leituras repetidas, volume retornado e tempo até a primeira inspeção relevante. Menos leituras não é critério suficiente se a revisão deixar passar defeitos.

### R3a Aplicabilidade e requisitos de checks

Hooks configurados já registram resultado, identidade e logs; começar pela correção da seleção dos checks que influenciam a revisão. Separar três categorias: histórico observado, aplicável ao checkout revisado e requisito de validação ainda pendente. Registrar mais evidência não pode invalidar uma revisão apenas porque um teste histórico foi executado em outra raiz ou antes da correção.

Manter histórico sem promovê-lo a aprovação ou veto automático. Somente checks aplicáveis participam da decisão atual; requisito obrigatório não atendido permanece pendente. Esse filtro é responsabilidade do servidor, não escolha conveniente do modelo. Definir identidade por check, comando/argv, cwd, fonte e ambiente, preservando distinção entre falha atual e teste vermelho anterior.

A obrigatoriedade vem de configuração autorizada do projeto, requisito explícito do usuário representado no contrato ou configuração de avaliação congelada pelo driver; nunca de flags livres do modelo. Na primeira versão, todo hook habilitado continua obrigatório. Não introduzir silenciosamente uma opção que transforme hook falho em diagnóstico opcional. Diagnósticos opcionais só podem ser classificados como tal por política explícita do servidor, anterior à execução.

| Evidência | Efeito na revisão atual |
| --- | --- |
| Histórico, inclusive teste vermelho ou de outra fonte | Informativo; não veta sozinho nem satisfaz requisito atual |
| Diagnóstico opcional explicitamente configurado | Informativo e com limitações visíveis; sucesso não satisfaz requisito e falha não vira automaticamente aprovação ou finding |
| Requisito obrigatório sem execução aplicável, incompleto ou sem identidade | Validação pendente; não permite aprovação limpa |
| Requisito obrigatório aplicável com falha ou timeout | Impede aprovação limpa; finding concreto ainda pode habilitar reparo sob os demais guards |
| Todos os requisitos obrigatórios aplicáveis passaram | Permite considerar aprovação estruturada; identidade estável e demais condições continuam obrigatórias |

Um resultado que revela defeito concreto continua disponível à revisão independentemente de sua categoria. A classificação não autoriza apagar falhas nem rebaixar requisitos depois de conhecer seus resultados.

Não classificar qualquer `exec` como check com base em `purpose`, nome ou exit code. Não desativar hooks porque existe algum check: deduplicar cada hook pela identidade exata aplicável. Um teste bem-sucedido não cobre automaticamente outro backend, outro comando ou dependências diferentes.

A primeira entrega não inclui cache entre ambientes. Reutilização entre worktree e principal fica desabilitada enquanto equivalência de fonte e ambiente não puder ser demonstrada. Os fingerprints atuais não provam identidade dos conteúdos de todas as dependências; essa limitação não será omitida.

Aceite: teste vermelho antes da implementação, teste na worktree seguido de integração, reparo seguido de novo teste e checks homônimos em ambientes distintos não contaminam a decisão atual. Falha de requisito atual não some na classificação. Checks necessários continuam executando mesmo com inventário parcial, desde que suas próprias condições de autorização e identidade sejam satisfeitas.

Testar uma suíte real que gere caches/artefatos, usando scratch e ambiente apropriados. Medir fração de checks atribuíveis e custo da observação. Não excluir diretórios de fonte ou converter `changed`/`unknown` em confirmação para obter números melhores.

### R3b Canal explícito para checks do agente

Fechar a lacuna entre testes chamados pelo provider e o índice de evidências por uma capacidade explícita, não por interpretação de shell. Primeira versão: o agente seleciona por identidade de configuração um check registrado pelo servidor/projeto; a execução passa pelo runner existente, autorização efetiva e cancelamento do Run. O contrato atual não possui essa identidade estável: acrescentar ID e revisão de configuração vinculados ao comando, timeout, estado habilitado e política de requisito. ID não pode ser índice de array ou apenas nome. Validar a revisão atual ao despachar; reorder não muda o check selecionado, edição/desativação invalida referências antigas. O registro e a seleção entram no contrato do provider; `checkEventId` identifica separadamente cada invocação e sua referência paginada de log.

Checks disponíveis vêm da configuração autorizada ou de uma seleção explícita validada pela política existente. Propostas ad hoc do agente não viram comandos aprovados por estarem rotuladas como teste. Comandos fora desse canal continuam telemetria de ferramenta e relatos; essa limitação deve aparecer no produto. Não acrescentar uma chamada classificadora de modelo para inferir checks.

Registrar comando/argv, cwd, fonte antes/depois, ambiente observado, resultado, duração e referência privada do log. Aplicar as categorias de R3a antes de entregar a evidência à revisão. Falhas, timeouts e logs incompletos permanecem recuperáveis; consumo de disco, retenção e acesso seguem R0b, sem depender da captura de conteúdo de patches para lançar R3b.

Aceite: uma solicitação explícita real do provider executa o check selecionado, produz evento/log atribuível e pode ser consultada pelo reviewer; a mesma invocação por `exec` genérico não recebe validação inferida. Mudança de fonte, ambiente ou dependência relevante impede reutilização. Medir a cobertura desse canal e as verificações duplicadas efetivamente evitadas, sem disparar todas as suítes antes de cada revisão.

### R4 Revisão após reparo orientada pelo delta

O tracking dos findings e a orientação textual para reavaliá-los já existem. A novidade é entregar à segunda revisão baseline/delta observados e recuperação de evidências atribuíveis. Começar pela resolução dos achados e por regressões introduzidas pelo reparo, mantendo acesso ao diff completo e aos arquivos relacionados.

Não esconder achados inconvenientes, aceitar silêncio como resolução nem impor aprovação ao atingir um limite de tempo. O limite de um reparo e a revisão independente permanecem. Eventos devem distinguir finding confirmado, não resolvido e resolução não confirmada.

Aceite: detectar controles com regressão fora dos arquivos editados no reparo, finding antigo omitido e ID reutilizado indevidamente. Demonstrar menor reconstrução de contexto e ganho de tempo sem perda de detecção. Se o ganho não se reproduzir, manter o fluxo atual.

### R5 Continuidade do worker dentro do Run

Primeiro realizar ensaio técnico isolado, somente em memória, depois experimento real. O ensaio mantém a investigação do worker disponível para a única correção, com reviewer independente. Não criar nesta etapa um coordenador global persistente nem persistência de threads entre reinícios.

A unidade de propriedade precisa incluir Run, tarefa, thread, processo, worktree, baseline, permissões, ferramentas e prazo absoluto. Integração no checkout principal, revisão em outro contexto e eventual alteração concorrente precisam de reconciliação explícita antes de retomar. ID de sessão sozinho é insuficiente.

O ensaio deve nomear os pontos de retenção e liberação do servidor e da worktree, incluindo erro e abandono da correção. Aceite técnico: cancelamento encerra os recursos próprios; reinício abandona a continuação volátil e preserva a entrega recuperável; mudanças de fonte ou permissão invalidam a retomada; não existe compartilhamento entre projetos; encerramento preserva o patch e a atribuição de uso. Revalidar o protocolo da CLI instalada antes de escolher a estratégia de thread/turno.

Aceite de produto: comparar worker novo e worker continuado a partir do mesmo patch e findings. Reduzir reinvestigação e melhorar tempo ou resolução no fluxo completo. Se só o microteste melhorar, não promover o recurso nem construir persistência durável.

### R6 Redução de fases e atritos de ferramentas

Tratar cada hipótese separadamente. Reaproveitar as heurísticas existentes de tarefa coesa e finalização factual; verificar quando planejamento ou síntese por modelo acrescentam informação necessária. O teto observado dessas duas fases no diagnóstico recente é aproximadamente 32 s, sem previsão de economia integral.

Classificar erros de ACI por uso incorreto, contrato ambíguo, conflito legítimo, ausência de recurso e defeito do executor. Melhorar exemplos, mensagens e comportamento da ferramenta existente apenas onde houver benefício verificável. Suporte a busca em arquivo pode ser um experimento pequeno; nova ferramenta de patch ou edição em lote requer evidência adicional.

Aceite: questões simples continuam no caminho curto; tarefas amplas e continuações ambíguas não são indevidamente simplificadas; nenhuma redução contorna o isolamento. Queda nos erros evitáveis e no tempo precisa preservar correção. Não repetir a restauração genérica das instruções nativas já testada negativamente sem hipótese nova.

### R7 Roteamento de modelos e delegação especializada

Investigar apenas depois de separar os efeitos do fluxo. Manter Luna como opção de implementação e Sol como coordenação/revisão durante os experimentos pertinentes. Comparar com o mesmo modelo em ambos os fluxos antes de atribuir a perda ao worker.

Escalada para Sol precisa de gatilho observável no contexto público da tarefa, como reprodução ainda falha após tentativa verificada, e compartilhar o orçamento original. Não usar a nota oculta como gatilho. Delegar em paralelo somente fronteiras realmente independentes; investigação, implementação e teste de um defeito coeso podem permanecer com um executor.

Skills devem resolver necessidades específicas descobertas em várias tarefas, com carregamento sob demanda. Não carregar catálogo, grafo ou memória completos para compensar perda de contexto. Especialização e novos modelos permanecem hipóteses, não requisito da próxima entrega.

Aceite: comparação de qualidade e consumo por modelo, redução de custo por entrega aceita quando a estimativa de preço for confiável, e ausência de escaladas repetitivas ou recursivas. Preço de assinatura e custo faturado desconhecido não são tratados como zero.

### R8 Validação em casos reservados e promoção

Toda intervenção passa primeiro por fixtures sem modelo, depois por um piloto real pequeno. Congelar IDs, versão, configuração, métricas, critério de interrupção e condição de promoção antes da inferência. Trocar uma variável por vez.

Para avaliar uma intervenção, comparar Adelic de controle e Adelic candidato no mesmo fluxo, modelo, esforço, ferramentas e ambiente. Comparar direto/coordenado é um experimento separado sobre o custo da orquestração. Se uma equivalência de worktree ou ferramentas exigir adaptação, identificá-la como braço experimental, não alegar ablação pura.

Piloto de desenvolvimento: duas tarefas preselecionadas e dois braços, quatro execuções, com ordem contrabalançada. Uma tarefa conhecida pode diagnosticar o mecanismo; a outra não deve ter sido usada para ajustá-lo. Antes de iniciar, reservar um único segundo bloco de quatro execuções para confirmar um candidato promissor. Esse segundo bloco tem os mesmos pares e ordem inversa, sem alterar o candidato. Pode-se encerrar por resultado negativo ou falta de sinal após o primeiro bloco; não se pode declarar promoção de eficiência sem a confirmação prevista. O teto é oito execuções de desenvolvimento por candidato, sem repetir até conseguir aprovação.

Para o protocolo SWE inicial, manter 600 s totais por tentativa: interromper o solver até 570 s e reservar os 30 s finais dentro desse teto para captura e encerramento. Execuções são seriais, com fonte congelada; registrar carga, ordem, aquecimento e cache observado. Preparação e avaliação externa têm limites próprios no manifesto e não entram silenciosamente na comparação de latência. Outra jornada pode usar janela própria fixada antes da execução.

O manifesto fixa critérios de validade: controles inválidos, fonte/perfil incorretos, captura essencial ausente, feedback oculto ou término não confirmado impedem comparação. Falha de código, timeout e cancelamento por orçamento não são motivo para invalidar uma nota ruim. Por padrão, não há reposição de tentativas inválidas: corrigir o protocolo, preservar o registro e encerrar a campanha como inválida/inconclusiva. Um novo candidato ou protocolo exige nova campanha identificada, sem reaproveitar as melhores notas.

Conjunto de confirmação antes de mudar padrões: quatro tarefas novas preselecionadas, em pelo menos dois repositórios e duas faixas de dificuldade, com dois braços, oito execuções. Registrar IDs e distribuição em artefato operacional antes da inferência, com conteúdo oculto ao desenvolvimento até congelar o candidato. São no máximo dezesseis execuções somando desenvolvimento e confirmação por candidato; uma referência Codex adicional exige orçamento separado, explícito no manifesto. Não abrir esse conjunto se os gates anteriores falharem.

Cada conjunto reservado serve para uma confirmação. Depois de revelar o resultado, seus casos tornam-se desenvolvimento/regressão; ajustes posteriores precisam de outra confirmação inédita. A configuração mista entra somente quando a pergunta sobre efeito do modelo justificar chamadas adicionais. Uma referência Codex contemporânea é necessária antes de declarar aproximação ao Codex atual; a referência histórica continua identificada como histórica.

Interromper por violação de validade, regressão relevante conhecida, limite de recursos ou critério negativo predefinido; registrar a causa e preservar tentativas anteriores. Sem conclusão dentro do teto, registrar inconclusivo. Usar a campanha antiga como sentinela de regressão, sem substituir notas pelas melhores retentativas. O pacote mais amplo de comparação externa é uma decisão posterior; não está incluído automaticamente no teto desta campanha.

## Métricas e regras de promoção

| Dimensão | Métrica principal | Regra |
| --- | --- | --- |
| Validade | Controles, perfil, fonte e término confirmados | Comparação inválida é preservada e corrigida; não vira evidência de ganho |
| Correção | Tarefas oficialmente resolvidas sobre todas as tentativas e regressões | Exigir resoluções aceitas em ambos os braços, nenhuma perda pareada e nenhuma regressão relevante conhecida para promover otimização de eficiência |
| Latência | Tempo total por tentativa e tempo agregado dividido pelas resoluções aceitas | Reportar todos os tempos, incluindo falhas/cancelamentos; meta global de 20% na mediana das razões pareadas candidato/controle, com qualidade preservada e confirmação inédita |
| Contexto | Entrada não cacheada, cacheada e saída por fase/modelo | Cache é subconjunto da entrada; raciocínio é subconjunto da saída |
| Interação | Ferramentas, erros classificados e exploração repetida | Métrica diagnóstica; menos chamadas não prova solução melhor |
| Consumo econômico | Consumo/custo de todas as tentativas dividido pelas entregas aceitas | Tarifas, tier e limitações explícitos; zero entregas torna o valor por entrega indefinido; faturamento desconhecido permanece desconhecido |
| Operação | Cancelamento, recuperação e limpeza | Nenhum recurso próprio sem proprietário ou execução residual não explicada |

A meta global de 20% corresponde a uma mediana de razões pareadas de no máximo 0,8, calculada sobre os pares válidos predefinidos, sem escolher depois a métrica mais favorável. Não é previsão nem significância estatística. O tempo agregado por resolução aceita também não pode piorar para declarar eficiência; com zero aprovações em qualquer braço, não há promoção por eficiência. Reportar resoluções/total e as durações de todas as tentativas ao lado da razão. Tempo somente entre aceitos é análise secundária.

Calcular e exigir esses gates separadamente na confirmação inédita. Não agregar resultados de desenvolvimento aos do conjunto reservado para mascarar ausência de ganho na confirmação. Publicar também os resultados de desenvolvimento, identificados como tal.

Entregas pequenas têm limiar próprio congelado antes do ensaio: R1 pode ser aceita por correção do contrato e R3 por atribuição correta, sem alegar redução de latência. R6 não precisa produzir sozinha 20%, pois o teto observado de planejamento/síntese é 5,9% dessa run. A meta de 20% vale para o candidato agregado de eficiência. Um piloto de quatro execuções orienta o próximo passo; nem ele nem os dezesseis ensaios propostos sustentam paridade ou não inferioridade populacional.

Uma mudança que aumenta aprovação com mais tempo pode ser candidata de qualidade, mas não deve ser promovida como ganho de eficiência. Registrar esse tradeoff e avaliá-lo sob o orçamento definido antes da rodada.

## Jornadas fora do SWE

Manter controles genéricos de defeito que exige editar dependência ainda inalterada, regressão após reparo, inventário incompleto, tarefa coesa, mudança em várias áreas, continuação com contexto anterior, projeto sem Git e cancelamento durante revisão ou retomada. Incluir o fluxo SSH e providers diferentes quando o componente alterado for compartilhado, sem copiar credenciais para executores.

Fluxos de UI alterados exigem verificação no preview T3, telas pequenas e tema escuro. Um ganho no benchmark não justifica degradação de projetos, aprovações, recuperação ou visibilidade do progresso.

## Organização da implementação e integração

O agente principal mantém contratos, decisões de escopo, integração e avaliação. Luna implementa unidades sem sobreposição; Sol e Astra revisam independentemente. Separar alterações de código das rodadas de avaliação para congelar a fonte, evitando edições concorrentes durante um benchmark.

R1 e R3a podem ser investigadas em paralelo após R0a, com ownership distinto e integração sequencial no orquestrador. R0b/R2 constituem a trilha de evidências duráveis; R3b só começa após fechar aplicabilidade e o canal de execução explícito. Não fundir essas intervenções no mesmo benchmark, para medir seus efeitos separadamente. R4 depende das evidências anteriores; R5 exige decisão explícita baseada no ensaio. Pequenos ajustes comprovados de ACI em R6 podem seguir após R0a, sem aguardar uma reformulação arquitetural.

Cada entrega implementada deve registrar hipótese, comportamento anterior/posterior, arquivos afetados, riscos, verificações, resultado negativo quando houver e decisão de manter ou reverter. Executar `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build` e `npm run test:e2e` quando um fluxo mudar. Alteração de SQLite exige nova migração. Aplicar `pre-pr-review` antes de criar ou atualizar um PR.

Promover primeiro como experimento com possibilidade de retorno ao comportamento anterior. Compatibilidade de estado persistido, encerramento de recursos e recuperação precisam de tratamento antes de habilitar por padrão. Commit, CI verde e aprovação de fixture não equivalem a ganho no SWE; release e deploy são entregas distintas.

## Marco de conclusão

O primeiro ciclo termina quando R0a permite medição confiável e R1/R3a têm decisão apoiada em reproduções determinísticas e fixtures. Esse marco não declara ganho no SWE. O segundo ciclo fecha a trilha necessária de evidência, R0b/R2 e/ou R3b, e avalia uma intervenção por vez. O terceiro ciclo confirma um candidato congelado nos casos reservados antes de mudar o padrão do produto. R4 a R7 podem ser adiadas ou rejeitadas por ausência de benefício. Não é necessário implementar toda hipótese para concluir um ciclo.

O objetivo de longo prazo é reduzir a distância de correção e tempo em relação a uma referência Codex contemporânea. O primeiro gate é demonstrar melhoria reproduzível sobre o próprio Adelic, preservando a qualidade e a operação. Paridade exige um protocolo pareado mais amplo; esta seleção de dez tarefas e seus retestes não bastam.
