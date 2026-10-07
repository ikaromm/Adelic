# Changelog

## Não publicado

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
