# Changelog

## Não publicado

- **Projetos SSH com login local**: Codex e Kiro rodam neste computador; um runner Python sem credenciais executa ferramentas no servidor. Cadastro com fingerprint confirmado, encaminhamentos SSH desativados, aprovação manual por chamada e histórico local preservado ao mudar de projeto. Veja [servidores SSH](docs/specs/remote-hosts.md).
- Navegação de pastas remotas, menções a arquivos, terminal com cancelamento e Git de leitura. Recursos que dependem de execução local (Graphify, coordenação, worktrees, hooks, MCP de projeto e automações) ficam desativados no projeto remoto.
- Proteções contra helpers Git, respostas RPC inesperadas e cancelamentos concorrentes. Usuário Unix compartilhado continua podendo alterar arquivos e influenciar saídas; não é uma fronteira de isolamento contra esse usuário. O runner não recebe login de modelo nem oferece um endpoint de inferência.

## 0.5.0 — 2026-10-07

- Correção: `ssh` falhava dentro do sandbox dos agentes e do terminal ("Bad owner or permissions on /etc/ssh/ssh_config.d/…"), porque no user namespace os arquivos do root aparecem como `nobody`. A configuração de cliente do OpenSSH passa a ser lida de cópias do usuário, somente leitura, e o socket do ssh-agent sob `/tmp` fica acessível. Veja [SSH dentro do sandbox](docs/specs/safe-command-approvals.md#ssh-dentro-do-sandbox).
- **Memória das conversas avulsas** (Configurações › Memória): escolha um escopo do ai-memory, como `pessoal/ambiente-ikaromm`, para conversas sem projeto; pedidos como "busca na memória o IP da VM" ou "search memory" passam a consultar só esse escopo, e a resposta diz qual escopo foi pesquisado quando nada é encontrado. Desligada por padrão. Veja [memória compartilhada](docs/specs/shared-memory.md#memória-das-conversas-avulsas).
- **Interface em inglês** (base): Configurações › Idioma / Language escolhe Português, English ou Automático (idioma do navegador), salvo no servidor e lembrado na tela de login; login, barra lateral, campo de mensagem e Configurações já traduzidos, e as mensagens de erro do servidor seguem o idioma pedido. O selo do topo mostra se a conexão é Local, Tailnet ou Internet, e pela internet o seletor de permissões mostra a aprovação manual obrigatória. Veja [idioma da interface](docs/i18n.md).
- **Menos confirmações para comandos de leitura**: scripts com `;`, `&&`, `||` e `|` (cada parte da allowlist), `2>/dev/null`/`2>&1`, git de leitura (status, log, diff, show, branch/tag --list…) quando nenhuma configuração do git pode executar programas, grep/sed -n/find/jq/wc/sort e a consulta Graphify sugerida pelo Adelic passam a ser aprovados automaticamente; no Kiro, comandos de shell seguros recebem allow_once. Veja [aprovações seguras](docs/specs/safe-command-approvals.md).
- **Acesso pela internet com usuário e senha** (Tailscale Funnel, opcional): uma conta criada só neste computador (Configurações ou `npm run remote-user`), senha com scrypt, sessões com cookie aleatório (7 dias sem uso, 30 no máximo) listadas e encerráveis, limites de tentativa e últimos acessos. O Funnel tem uma porta local própria, tratada sempre como internet, e é publicado só após confirmação. Pela internet, o terminal, MCP, automações, verificações, `git push` e o token ficam bloqueados, e as execuções pedem aprovação manual. O `ADELIC_REMOTE_TOKEN` continua valendo na tailnet. Veja [acesso remoto](docs/specs/remote-access.md).
- **Atualizar Adelic** em Configurações › Diagnóstico, só neste computador e sempre com confirmação: num checkout git avança o branch do canal (`master` ou `develop`) por fast-forward, recompila à parte e reinicia, voltando ao commit anterior se algo falhar; no AppImage baixa a release, confere SHA-256 e formato, troca o arquivo guardando o anterior e reinicia. Veja [atualizar o Adelic](docs/specs/self-update.md).
- Correção: pelo acesso remoto em HTTP (IP da Tailscale) o navegador não oferece `crypto.randomUUID` nem a área de transferência, e enviar uma mensagem falhava em silêncio (o botão ficava vermelho e nada aparecia). Os ids passam a usar `getRandomValues`, e copiar usa a alternativa já existente.
- Ditado por voz no campo de mensagem: o microfone grava até 2 minutos e o voxtype transcreve neste computador, com recusa se ele estiver configurado para um serviço remoto; o texto entra no cursor, sem enviar. Veja [ditado por voz](docs/specs/voice.md).
- **Terminal e preview do projeto**: executa comandos no mesmo sandbox dos agentes, sem enviá-los a nenhum modelo, com saída ao vivo (últimos 256 KB), código de saída, **Parar** e tempo limite. Também abre servidores de desenvolvimento locais (somente loopback) num preview. No acesso remoto, o terminal fica desligado salvo opção explícita. Veja [terminal e preview](docs/specs/terminal-preview.md).
- Instalável como app (PWA) no navegador em HTTPS ou localhost, por exemplo no celular com `tailscale serve`. Guarda só a interface, nunca `/api`, mostra "Sem conexão com o Adelic" quando o computador está fora do ar e pede para recarregar antes de trocar de versão. Veja [app instalável](docs/specs/pwa.md).
- Automações agendadas (desligadas por padrão): um pedido roda todo dia, em dias da semana ou a cada N horas, na sua própria conversa "⏱ nome", só enquanto o Adelic está aberto. Há um interruptor geral em Configurações, nenhuma aprovação é automática e as pendentes podem ser negadas após um prazo. Veja [automações](docs/specs/automations.md).
- Limites de uso, desligados por padrão: tokens e custo por dia e por mês, e por projeto no mês, conferidos antes de cada chamada ao agente (respostas, tarefas, compactação, resumo de passagem, fila). Avisa em 80% e, atingido, recusa com o motivo e **Continuar mesmo assim** para aquela mensagem; custo não informado nunca conta como zero. Veja [limites de uso](docs/specs/spend-limits.md).
- Painel **Git** do projeto: branch e upstream (à frente/atrás pelas refs locais), alterações staged, não staged e não rastreadas com diff, stage/unstage, descartar com confirmação, commit, `git push` sem forçar e link para abrir pull request no GitHub/GitLab; commits sem hooks por padrão. Veja [painel Git](docs/specs/git-panel.md).
- **Verificações e bloqueios** por projeto (Configurações): até 5 verificações (ex.: `npm test`) rodam depois de uma execução que alterou arquivos, no sandbox dos agentes e sem rede, com resultado e saída na atividade; **Corrigir automaticamente** (desligado por padrão) pede uma correção ao agente uma vez; comandos que casam com padrões bloqueados (`git push*`) são negados sem perguntar, mesmo no modo automático. Veja [verificações e bloqueios](docs/specs/project-hooks.md).
- Servidores MCP por projeto, desligados por padrão: catálogo local (somente stdio) em Configurações e uma chave por projeto. O Codex e o Kiro recebem só os servidores ligados, chamadas de ferramenta continuam pedindo aprovação e a execução é bloqueada se aparecer qualquer outro servidor MCP. Veja [catálogo MCP](docs/specs/mcp-catalog.md).
- **Trabalhar em uma cópia isolada (worktree)** por conversa: as execuções rodam num `git worktree` próprio, fora do repositório, em paralelo à pasta principal; o painel mostra os arquivos alterados e oferece **Aplicar no projeto** (merge `--no-ff` só com a pasta principal limpa e em um branch; conflito desfaz o merge) e **Descartar worktree**. Veja [cópia isolada](docs/specs/worktrees.md).
- Menções `@arquivo` no campo de mensagem: a lista sugere os arquivos do projeto enquanto você digita, e os arquivos de texto mencionados (até 5, 512 KB cada) entram no pedido ao agente, com o caminho conferido para não sair do projeto. Veja [menções de arquivos](docs/specs/mentions.md).
- Troca de modelo quando o atual está sobrecarregado ou no limite de requisições: **Tentar com outro modelo** oferece até 3 alternativas e muda a conversa para a escolhida; opcionalmente, **Trocar de modelo se o atual estiver sobrecarregado** tenta até 3 modelos configurados, só naquela resposta, depois das novas tentativas e só sem efeito visível. Veja [troca de modelo](docs/specs/retries.md#troca-de-modelo).
- Paleta de comandos com Ctrl+P (⌘P): ações, conversas, projetos, agente e modelo, modo e comandos salvos, com busca sem acentos e escolhas recentes primeiro. Veja [paleta de comandos](docs/specs/command-palette.md).
- Editar e reenviar uma mensagem (descarta as seguintes, após confirmação, e recomeça a sessão do agente com o histórico anterior) e **Ramificar daqui**, que copia a conversa até uma mensagem para uma nova, com link para a original. Veja [editar e ramificar](docs/specs/edit-branch.md).
- **Continuar com outro agente**: troca o agente da conversa levando um resumo escrito pelo agente atual (somente leitura, com resumo local se ele falhar) ou só o histórico recente; o resumo aparece como cartão "Passagem para …" e é o contexto das próximas execuções. Veja [continuar com outro agente](docs/specs/provider-handoff.md).
- Compactar conversa (menu da conversa ou `/compactar`): uma chamada somente leitura resume a conversa em objetivo, decisões, estado, arquivos, perguntas e próximos passos. As próximas mensagens partem do resumo, numa sessão nativa nova, e as anteriores ficam recolhidas e pesquisáveis. Há uma opção automática, desligada por padrão, para conversas longas. Veja [compactação](docs/specs/compaction.md).
- Modo de planejamento: **Planejar antes** ou `/plano` gera, em modo somente leitura, um plano com requisitos, design e tarefas; o cartão permite editar, aprovar e executar uma tarefa por execução (com checkpoint), parar, pular, tentar de novo e salvar em `.adelic/specs/`. Veja [modo de planejamento](docs/specs/plan-mode.md).
- Comandos salvos com `/` no início da mensagem: `/revisar`, `/testes` e `/explicar` embutidos, comandos próprios (globais ou por projeto) em Configurações e arquivos `.adelic/commands/*.md` do repositório. O servidor expande o modelo (`{{args}}`) e a conversa mostra o que foi digitado. Veja [comandos salvos](docs/specs/saved-commands.md).

- Notificações do sistema quando uma resposta fica pronta, uma execução falha ou uma aprovação é necessária, só com a janela em segundo plano, e contador no título da aba. Ligado por padrão no desktop; no navegador, pede permissão. Veja [notificações](docs/specs/notifications.md).
- Anexos nas mensagens: imagens (PNG, JPEG, WebP, GIF até 10 MB) para Codex e Kiro, e arquivos de texto (até 512 KB) para todos os agentes, pelo clipe, colando ou arrastando, até 5 por mensagem; veja [anexos](docs/specs/attachments.md).
- Cada execução que pode escrever num projeto git mostra os arquivos que alterou ("Alterou 3 arquivos (+12 −4)"), o diff de cada um e **Desfazer alterações desta execução**, que é recusado se algum arquivo mudou depois. HEAD, branches, índice e stash nunca são tocados; veja [checkpoints](docs/specs/checkpoints.md).
- Fila de mensagens enquanto o agente trabalha: Enter coloca na fila (editável, salva no servidor) e a próxima começa quando a resposta termina; cancelamento ou falha pausam a fila até **Retomar fila**. Ctrl+Enter envia agora, interrompendo após confirmação, e no Codex é possível orientar o turno em andamento. Veja [fila de mensagens](docs/specs/message-queue.md).
- Repetição automática de falhas temporárias (tempo esgotado, conexão interrompida, modelo sobrecarregado), com espera crescente e até 2 novas tentativas, só quando a tentativa não exibiu texto, não executou ferramenta nem pediu aprovação. Falhas mostram o motivo e um botão **Tentar de novo**; configurável em Configurações. Veja [repetição automática](docs/specs/retries.md).
- Busca em todas as conversas (títulos e mensagens, sem diferenciar acentos) com Ctrl+Shift+F, e exportação da conversa aberta em Markdown ou JSON.
- Tokens por execução, quando o provedor informa (Codex informa; custo continua "não informado", nunca zero).
- Aviso de nova versão, opcional e desligado por padrão: uma consulta anônima ao GitHub, sem baixar nem instalar nada.
- Acesso remoto opcional e desligado por padrão, protegido por token (`ADELIC_REMOTE_BIND` e `ADELIC_REMOTE_TOKEN`); veja [acesso remoto](docs/specs/remote-access.md).
- Respostas do ai-memory e dos CLIs validadas com zod; formatos inesperados viram erros claros em vez de campos vazios.
- AppImage testado na CI também em Ubuntu 22.04, Debian 12 e Fedora 42; a release só é publicada depois do smoke do AppImage e traz atestado de proveniência.
- Testes de integração contra ai-memory 2.1.0 e 2.5.2, cobertura com piso, Dependabot, e novos testes de memória, delegação e criação de projeto.
- Avaliação do ai-jail ([decisão](docs/specs/ai-jail.md)) e [propostas ao ai-memory](docs/specs/ai-memory-proposals.md).

## 0.4.0 — 2026-10-06

- Desenvolvimento: ESLint e Prettier com verificação no CI, código formatado (commit ignorado no `git blame`), rotas do servidor divididas em `server/http/` e telas do front em `src/components/`. Sem mudança de comportamento.
- Testes que falhavam de forma intermitente no CI corrigidos (handler de SIGTERM instalado antes de anunciar o pid).
- Erros de renderização mostram uma mensagem com "Tentar de novo" e "Recarregar" em vez de uma janela em branco; a navegação continua funcionando.
- Esquema do SQLite versionado, com cópia automática da base antes de cada migração e recusa de bases criadas por versões mais novas.
- Validação das requisições com zod, mantendo as mesmas mensagens de erro.
- Testes E2E com Playwright para os fluxos principais (enviar, aprovar, negar, cancelar, navegação, erro de memória e tela pequena), também no CI.
- Cartão **Diagnóstico** em Configurações: versões do Adelic, do Node e dos agentes, caminhos, esquema da base, cópias, bubblewrap e estado do ai-memory, com opções de copiar e baixar. Não inclui credenciais nem conversas.
- Testes de integração com um ai-memory real (2.1.0, com token), também no CI.
- Dependências atualizadas: Vite 8 (build cerca de 10 vezes mais rápido), plugin React 6, lucide-react 1 e @types/node 26. O TypeScript continua no 5.9 porque o typescript-eslint ainda não suporta a versão 7.
- Release automatizada: `npm run release -- X.Y.Z` prepara versão, CHANGELOG, notas e tag; a tag publicada gera o AppImage e a release no GitHub.
- Atalhos e rolagem da conversa extraídos para hooks testados, sem mudança de comportamento.

## 0.3.0 — 2026-10-06

- Tema escuro inspirado no Dracula, um pouco mais escuro, com tokens de cor e contraste AA calculado; fontes Inter e JetBrains Mono incluídas no aplicativo.
- Interface baseada no T3 Code: barra lateral com conversas recentes e tempo relativo, navegação no rodapé e trilho recolhido; mensagem do usuário em bolha; atividade do turno como “Trabalhou por …” com cronômetro; campo de mensagem com modelo, thinking, permissões e projeto/modo em pílulas.
- Menus posicionados junto ao botão, com foco no item selecionado; rolagem segue o fim só quando você já está lá, com botão para voltar à mensagem mais recente.
- Botões de copiar em mensagens e blocos de código; links externos abrem fora do aplicativo; textos visíveis com pelo menos 11 px.
- Memória com ai-memory em Docker: catálogo, listagem, busca, leitura, criação e edição passam pela API do serviço (`/api/v1`, MCP e `/admin/write-page`), sem acesso ao SQLite ou ao Markdown do serviço. `ADELIC_MEMORY_URL` e `ADELIC_MEMORY_TOKEN`/`ADELIC_MEMORY_TOKEN_FILE` configuram endereço e token. Erros de serviço indisponível, token, API ausente ou catálogo incoerente aparecem na tela em vez de um catálogo vazio. Notas com metadados que o serviço não consegue reproduzir ficam bloqueadas para edição.
- Kiro: a disponibilidade usa só o resultado explícito da verificação `Auth` do `kiro-cli doctor --all`. Falhas de dotfiles ou integração do terminal (Qterm, kiro-cli-term), que podem deixar o código de saída diferente de zero, não marcam mais um Kiro autenticado como indisponível. `✘ Auth`, ausência da verificação, diagnóstico interrompido por timeout e catálogo de modelos vazio continuam bloqueando.
- Nova logo: uma árvore 2-ádica em forma de "A" atravessada pela reta real, as duas metades que o anel de adeles une. Usada no ícone do aplicativo, no favicon e na barra lateral.
- Integração contínua no GitHub Actions (typecheck, testes com bubblewrap real e build), e testes que dependiam de temporização ou da pasta temporária corrigidos.

Evidências e limites em [notas da v0.3.0](docs/releases/v0.3.0.md) e [validação](docs/validation.md).

## 0.2.0 — 2026-10-06

- Memória compartilhada com ai-memory: biblioteca independente de projeto, pesquisa por escopo, edição e atualização externa com proteção de rascunhos e conflitos.
- Chat com atividade recolhida junto ao turno e controles no rodapé.
- Menus arredondados com busca de modelos e thinking conforme o catálogo real do modelo, incluindo níveis adicionais anunciados.
- Ferramentas locais disponíveis no caminho rápido, mantendo um executor e contexto curto.
- Aprovação automática conservadora das consultas reconhecidas; solicitações destrutivas, sensíveis e ambíguas continuam visíveis para confirmar ou negar.
- Proteção contra alterações concorrentes de sessão durante a descoberta de modelos.

Evidências e limites em [notas da v0.2.0](docs/releases/v0.2.0.md) e [dogfooding](docs/dogfooding.md).

## 0.1.1-dev.2 — local

- Controles de agente, modelo e thinking junto ao campo de mensagem; projeto e modo nas opções recolhidas do rodapé.
- Topo do chat sem faixas repetidas de configuração, vínculo e coordenação.
- Ajuda e envio/cancelamento acessíveis em telas pequenas e janelas baixas, com opções roláveis e foco visível.
- Implementação feita pelo próprio Adelic, com executores Luna e revisão Astra; evidências e limitações em `docs/validation.md`.

## 0.1.1-dev.1 — desenvolvimento local

- Ferramentas locais disponíveis também no caminho rápido, mantendo um executor e contexto curto.
- Perfis Codex separados para respostas rápidas com ferramentas locais, execução completa e chamadas internas sem ferramentas.
- Permissões, aprovações e thinking preservados; uso de comandos continua registrado na atividade do turno.

## 0.1.1-dev.0 — desenvolvimento local

- Atividade recolhida e vinculada ao respectivo turno, com detalhes de tarefas e comandos sob demanda.
- Seletor de thinking por conversa: Automático, Baixo, Médio e Alto, independente do modo de execução.
- Ajustes de leitura para tabelas, código e controles do chat.

## 0.1.0 — 2026-10-04

Primeira versão do Adelic, com aplicativo web local e desktop Linux x86_64 em AppImage.

- Chat com streaming, histórico SQLite, cancelamento, aprovações e exportação.
- Conversas avulsas ou vinculadas a projetos; vínculos preservam histórico.
- Roteamento adaptativo Auto/Rápido/Completo e delegação por projeto com planejamento, executores, revisão e síntese conforme a tarefa.
- Graphify como mapa de código e ai-memory com escopo explícito, disponíveis quando os serviços externos estão instalados.
- Integrações com as CLIs Codex, Kiro e Claude Code; OpenCode oferece descoberta nesta versão.
- Interface escura, seleção de modelos, configurações e acompanhamento das tarefas.
- Electron com Node/SQLite incorporados, inicialização automática do backend em loopback, bloqueio da base, segunda instância e encerramento dos subprocessos.
- Descoberta de CLIs por mise, caminhos locais, PATH e overrides executáveis.
- Instalador Linux opcional, AppImage e checksum SHA-256.

Validação: typecheck/build, 88 testes, smoke do AppImage com histórico preservado e respostas reais Codex/Kiro. Compatibilidade comprovada neste incremento: Arch/Omarchy x86_64; outras distribuições ainda precisam de testes. Claude Pro/Max ainda não teve inferência real validada neste ambiente.

Detalhes em [notas da v0.1.0](docs/releases/v0.1.0.md), [uso do desktop](docs/desktop-linux.md) e [evidências](docs/validation.md).
