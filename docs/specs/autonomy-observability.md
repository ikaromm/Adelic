# Autonomia e observabilidade geral

## Política de execução

O modo de aprovação e o sandbox são configurações independentes. Os modos são `manual`, `auto-safe` (automático seguro existente) e `automatic` (executar solicitações elegíveis sem perguntas). Configurações antigas preservam sua política. A política efetiva é capturada no começo da execução, incluindo tarefas delegadas; alterar a configuração durante um turno não amplia aquele turno.

A conversa pode substituir a política do projeto; o projeto pode substituir a configuração global. Configurar o Automático exige a interface local. No acesso pela internet, a exigência de aprovação manual permanece. Projetos SSH exigem uma escolha explícita de Automático na conversa ou no projeto; apenas selecionar o modo global não libera o servidor remoto.

Bloqueios explícitos do projeto, ferramentas indisponíveis, planejamento sem escrita e barreiras do sandbox continuam valendo antes de qualquer aprovação automática. O modo não concede elevação de privilégios, não remove o bubblewrap e não transfere login de modelos ao servidor. No SSH, comandos têm as permissões do usuário Unix remoto, que pode ser compartilhado; esse executor não é um sandbox contra esse usuário.

No modo Automático local, Codex e Kiro recebem apenas ferramentas do executor isolado. O processo autenticado do provedor permanece local, mas suas ferramentas nativas de shell e arquivos ficam desativadas. O executor tem uma raiz de filesystem própria, ferramentas do sistema montadas somente para leitura e apenas a pasta do projeto em `/workspace`. Não recebe o ambiente do usuário, não vê a home pessoal nem processos do host e não tem rede. Cada chamada usa seu próprio namespace de processos e só retorna após encerrá-lo, inclusive seus processos em segundo plano. Serviços persistentes devem ser iniciados pelo terminal integrado. Credenciais ou outros dados que estejam dentro da própria pasta do projeto continuam acessíveis; essa pasta é o limite autorizado. Projetos que abrangem a raiz do sistema, namespaces do host ou a home pessoal são recusados. Subpastas de projeto em discos montados e em `/tmp` continuam disponíveis, mas as raízes inteiras desses locais não podem ser usadas como projeto.

Esse executor exige Linux, Python 3 e bubblewrap. A falta de um requisito ou uma falha ao iniciar bloqueia a ferramenta, sem recorrer ao shell nativo. Instalações de ferramentas guardadas na home não ficam automaticamente disponíveis; o runtime Node e seu npm podem ser montados separadamente quando identificados como uma instalação válida. Instalar dependências que exijam rede deve acontecer fora desse executor. O provedor de cada fase com ferramentas é validado antes de iniciar a execução coordenada; fases sem ferramentas não recebem o executor nem permissões automáticas. Claude e OpenCode não oferecem o modo Automático local nesta versão; manual e automático seguro continuam com suas capacidades existentes.

A interface mostra o modo ativo e conserva a ação de parar. Decisões automáticas têm origem e resultado registrados. Os provedores diferem nas solicitações emitidas e nas ferramentas nativas; o Adelic não afirma observar toda chamada interna de modelo ou todo efeito de um processo que não emita eventos.

## Observabilidade local

A tela de Observabilidade consulta dados históricos com filtros e paginação; os totais não dependem dos 100 runs do bootstrap. A execução pode ser aberta para ver sua linha do tempo correlacionada. Tokens e custos desconhecidos permanecem desconhecidos. Cada total de consumo só é exibido quando todos os runs filtrados reportaram aquele campo; os valores individuais conhecidos continuam disponíveis.

Uma execução correlaciona eventos de aprovação, ferramentas, retries e fases instrumentadas de processo/RPC, memória, Graphify, Git, terminal e SSH. A camada HTTP mede duração e resultado, sem gravar corpo ou query. O runtime informa uso de memória do processo e observa atrasos do event loop. O desktop registra inicialização, janela pronta e saída do backend; seu arquivo local limitado permite guardar uma falha quando o backend está indisponível e importar os últimos registros na próxima abertura.

Metadados de observabilidade ficam em SQLite, fora do Git. Resumos de runs acompanham o histórico operacional; eventos e spans têm retenção de 30 dias e limite de 10.000 registros. A fila e as tarefas ativas são snapshots do momento da consulta, separados do período histórico. O backfill de versões antigas usa o projeto atualmente associado à conversa, porque o vínculo histórico não foi registrado. O filtro por componente considera somente eventos ainda retidos; resumos mais antigos continuam consultáveis pelos demais filtros. O histórico de conversas não é apagado pela retenção de telemetria. O arquivo desktop tem rotação e só contém nomes fixos, timestamps, ids, duração e resultado. A API de observabilidade é local; exportação para um serviço externo não é ativada.

A telemetria usa campos permitidos e não guarda prompts, comandos, conteúdo de arquivos, stdout, ambiente ou mensagens de erro brutas. Histórico e aprovações já existentes continuam nos seus próprios registros operacionais. Eventos da interface recebidos pela API têm schema fechado. Falhas da telemetria não devem interromper o trabalho.

Um componente com eventos antigos não é declarado saudável: uma observação histórica e uma verificação ativa são evidências diferentes. Instrumentação de ferramentas/protocolos não cria visibilidade de requisições internas que o runtime não informa.

## Validação local — 2026-10-08

As mudanças foram exercitadas com provedores roteirizados, bases temporárias e bubblewrap real neste Linux x86_64. Os testes verificam acesso a canários fora do projeto, symlinks, ausência de rede, Node/npm, somente leitura, cancelamento e um processo destacado com `setsid`. Também cobrem bloqueios nos dois provedores, política manual da internet, escolha explícita para SSH, fases delegadas compatíveis, migração/backfill, paginação além dos 100 runs, retenção, dados desconhecidos e ausência de conteúdo bruto na telemetria.

A interface foi exercitada no preview T3 e na suíte E2E, incluindo 390×844, seleção de autonomia, timeline atualizada, filtros e erros genéricos da interface. O snapshot visual do T3 falhou nesta sessão; inspeção DOM e interações funcionaram depois de restabelecer a navegação. O AppImage de validação é Linux x86_64 e o smoke test usa o Node 24.21.0 do Electron, pasta de dados temporária, preservação de histórico e encerramento dos processos.

A revisão de integração por Sol e a revisão independente por um codificador Luna de outro escopo corrigiram bloqueadores antes da aprovação. A revisão Astra não pôde ser iniciada por limite de threads de agentes. Estes testes não fizeram novas chamadas pagas aos modelos nem alterações em servidor SSH real; a validação anterior de Codex/Kiro com modelos reais na versão 0.5.2 é uma evidência separada. As mudanças desta etapa são disponibilizadas no branch `develop` para testes pelo código-fonte. Ainda não há uma nova release nem instalação no AppImage principal.

## Referências

- [T3 Code: observabilidade](https://github.com/pingdotgg/t3code/blob/main/docs/operations/observability.md) e [modos de permissão](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md).
- [Hermes: dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard), [hooks](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md) e [segurança](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/security.md).
- [OpenCode: permissões](https://docs.opencode.ai/docs/permissions/).
- [Claude Code: monitoramento](https://code.claude.com/docs/en/monitoring-usage).
