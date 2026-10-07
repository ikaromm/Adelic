# Adelic

Aplicativo local para conversar com agentes, organizar projetos e compartilhar contexto, com interface web e pacote desktop Linux. A primeira versão usa os runtimes instalados no computador; o login continua no Codex, Claude Code ou Kiro.

Baixe a **[v0.4.0 para Linux x86_64](https://github.com/ikaromm/Adelic/releases/tag/v0.4.0)**: AppImage, checksum e instalador opcional estão nos assets da release. As [notas da versão](docs/releases/v0.4.0.md) descrevem os recursos e limites; o [changelog](CHANGELOG.md) registra as versões, e a seção "Não publicado" lista o que já está no código e ainda não saiu em release.

O desktop Linux x86_64 usa Electron e AppImage, com Node e SQLite incorporados. Para gerar e instalar o pacote local:

```bash
npm ci
npm run package:linux
./scripts/install-linux.sh
```

O artefato fica em `release/Adelic-<versão>-linux-x86_64.AppImage`, acompanhado de SHA-256. Quando houver vários builds, informe o arquivo ao instalador: `./scripts/install-linux.sh /caminho/Adelic.AppImage`. Copie o AppImage para outro Linux x86_64, dê permissão de execução e abra-o; o destino não precisa de Node/npm para executar o Adelic. O instalador opcional adiciona o comando `adelic` e um atalho no menu, sem apagar histórico. Veja [uso, dependências e testes do desktop](docs/desktop-linux.md).

Para desenvolver ou executar o modo web, requer Node.js 22.13 ou superior e npm:

```bash
npm install
npm run dev
```

Acesse **http://127.0.0.1:4317**. O servidor escuta somente no loopback. Para servir o build local: `npm run build` e `npm start`.

- **Auto** escolhe a rota por regras locais, sem uma chamada adicional de IA. Perguntas diretas usam esforço baixo e histórico reduzido; pedidos de arquivos, pesquisa e execução recebem recursos adicionais.
- **Rápido** força o caminho curto, com um executor e ferramentas locais disponíveis quando necessárias, sem busca automática de memória, grafo ou planejamento. Perguntas diretas podem ser respondidas sem executar comandos. **Completo** aumenta o contexto e o esforço; ferramentas são habilitadas quando o pedido exige.
- **Thinking** oferece Auto e os níveis anunciados pelo modelo escolhido, inclusive Muito alto, Máximo e Ultra quando disponíveis. A escolha explícita chega às tarefas delegadas com adaptação à capacidade de cada modelo; não ativa ferramentas ou memória por si só. Sem níveis anunciados, o seletor oferece somente Auto.
- **Orquestrador por projeto** começa ligado: delega execução e guarda um resumo compacto e os caminhos relevantes. Perguntas rápidas vão direto a um executor, com uma chamada. Trabalhos maiores podem envolver planejamento, executores, revisão e síntese; a tela acompanha as tarefas reais. Configurações permite escolher executor/revisor por projeto ou desligar a orquestração.
- **Graphify por projeto** começa ligado para orientar a busca em código. O CLI local constrói um grafo AST na primeira consulta e entrega recortes limitados; perguntas rápidas não consultam o grafo. Configurações mostra o estado do índice, permite atualizar e fazer consultas. Documentos semânticos não são indexados neste incremento.
- Conversas têm streaming, cancelamento, histórico persistido, registro de ferramentas e aprovações quando o runtime oferece esse protocolo.
- A atividade aparece junto ao turno, recolhida por padrão. Abra os detalhes para conferir tarefas e ações, e carregue a saída completa quando precisar. Aprovações e erros permanecem visíveis.
- **Nova conversa** e Ctrl/Cmd+K abrem chats avulsos. Use o **+ ao lado do projeto** para começar uma thread vinculada, ou o menu **Projeto e modo**, junto ao campo de mensagem, para anexar, trocar ou desvincular depois. Mensagens e histórico são preservados; mudanças de vínculo ficam bloqueadas durante execução.
- A interface usa um **tema escuro inspirado no Dracula**, com layout baseado no T3 Code: conversas recentes na barra lateral, mensagens suas em bolha, atividade do turno compacta e controles de modelo, thinking, permissões, projeto e modo no próprio campo de mensagem. Conversas avulsas mantêm delegação adaptativa e uma pasta de trabalho própria, sem carregar Graphify ou memória de outro projeto.
- **Memória** navega, pesquisa e edita a base compartilhada do `ai-memory` local, a mesma usada por T3/Codex e outros clientes. A biblioteca funciona sem projeto de código selecionado, possui catálogo por workspace/project e atualiza alterações externas; rascunhos e conflitos são protegidos. Nenhuma cópia das notas é importada para o banco do Adelic. O Adelic usa somente a API do serviço, então funciona igual com ai-memory instalado no computador ou em Docker; `ADELIC_MEMORY_URL` (padrão `http://127.0.0.1:49374`, só loopback) e `ADELIC_MEMORY_TOKEN`/`ADELIC_MEMORY_TOKEN_FILE` (quando o serviço usa `AI_MEMORY_AUTH_TOKEN`) configuram o acesso. Detalhes em [memória compartilhada](docs/specs/shared-memory.md). Cada projeto possui workspace e project explícitos. Para configurar este checkout, copie `.ai-memory.example.toml` para `.ai-memory.toml` e ajuste o escopo; a configuração local fica fora do Git.
- **Atividade** mostra tempos medidos e uso informado pelo provedor. Valores ausentes aparecem como indisponíveis.
- **Configurações** define provedor, modo, memória, estilo de resposta, permissão de escrita e procedimentos de contexto.

O SQLite fica em `~/.local/share/adelic/adelic.sqlite` por padrão. `ADELIC_DATA_DIR` permite escolher outra pasta. Desktop e web usam essa mesma base e não podem abri-la simultaneamente. Fechar a janela desktop cancela execuções e encerra o servidor; fechar somente um browser mantém o modo web ativo. Reiniciar o servidor marca trabalhos pendentes como interrompidos. A exportação JSON inclui os dados do aplicativo, sem importar automaticamente a wiki de memória.

Arquivos produzidos em conversas avulsas ficam em `~/.local/share/adelic/conversations/<id-da-conversa>/`. Vincular a conversa muda a pasta usada nos próximos turnos; arquivos já produzidos permanecem na pasta original.

Os índices Graphify ficam em `~/.local/share/adelic/graphs/<hash-do-caminho>/graphify-out/graph.json`, fora das pastas dos projetos. A saída completa de cada tarefa pode ser carregada pelo chat quando você quiser conferir os detalhes.

Codex e Kiro foram testados com respostas reais e leitura de arquivo. O adaptador Claude Code está implementado, mas o CLI deste computador precisa de login antes da validação com a assinatura Pro/Max. OpenCode oferece somente descoberta de instalação e modelos nesta versão; sua execução aparece indisponível.

Codex, Kiro e Claude usam bubblewrap no Linux para limitar escrita, além dos controles nativos disponíveis; a política padrão é somente leitura. Aprovação automática permite consultas locais reconhecidas; comandos ambíguos, scripts e pedidos sensíveis ficam para confirmação. O Kiro continua com aprovação manual porque o protocolo não comprova todos os dados do comando. Isso não isola a rede. A integração `ai-jail` está prevista e o aplicativo informa a disponibilidade real do binário. Provedores indisponíveis exibem o motivo; as assinaturas mantêm os limites dos runtimes oficiais. Após autenticar um CLI, reinicie o servidor para atualizar imediatamente a descoberta, que tem cache de cinco minutos.

O Adelic escuta só em `127.0.0.1` por padrão. Acesso remoto com usuário e senha, pela tailnet ou pela internet com o Tailscale Funnel, é opcional e fica desligado: veja [acesso remoto](docs/specs/remote-access.md). A avaliação do ai-jail está em [ai-jail](docs/specs/ai-jail.md).

### Recursos ainda não publicados

Estes recursos já estão em `develop` e entram na próxima release. Os que executam algo por conta própria ou saem do computador começam desligados.

- **Conversa:** [anexos](docs/specs/attachments.md) de imagens e arquivos de texto, [menções `@arquivo`](docs/specs/mentions.md), [fila de mensagens](docs/specs/message-queue.md) com Enviar agora e Orientar, [editar e ramificar](docs/specs/edit-branch.md), [compactação com resumo](docs/specs/compaction.md), [continuar em outro agente](docs/specs/provider-handoff.md) e [ditado por voz local](docs/specs/voice.md).
- **Planejamento e comandos:** [modo plano](docs/specs/plan-mode.md) (planeja somente leitura, você aprova, depois executa tarefa por tarefa), [comandos salvos](docs/specs/saved-commands.md) (`/revisar`, `/testes`…), [paleta Ctrl+P](docs/specs/command-palette.md) e [troca de modelo em sobrecarga](docs/specs/retries.md).
- **Arquivos e git:**
  - [alterações por execução e desfazer](docs/specs/checkpoints.md), em refs privadas;
  - [painel Git](docs/specs/git-panel.md), com hooks do repositório desligados por padrão;
  - [cópia isolada (worktree) por conversa](docs/specs/worktrees.md);
  - [verificações e bloqueios por projeto](docs/specs/project-hooks.md).
- **Ferramentas:** [terminal no sandbox e preview local](docs/specs/terminal-preview.md), [catálogo MCP por projeto](docs/specs/mcp-catalog.md) (opt-in, falha fechado), [automações agendadas](docs/specs/automations.md) (só com o Adelic aberto), [limites de uso](docs/specs/spend-limits.md), [notificações](docs/specs/notifications.md) e [instalação como app (PWA)](docs/specs/pwa.md).

Verificação local (a mesma do CI no GitHub Actions, em todo push para `develop` e em PRs):

```bash
npm run typecheck
npm run lint          # ESLint; `any` e dependências de hooks aparecem como avisos
npm run format:check  # Prettier; `npm run format` corrige
npm test
npm run build
npm run test:e2e      # Playwright; local: PLAYWRIGHT_CHROMIUM=/usr/bin/chromium, ou npx playwright install chromium
```

Alguns testes usam o bubblewrap real e esperam `rg` e `pactl` em `/usr/bin`. O commit que formatou o código inteiro está em `.git-blame-ignore-revs`; para o `git blame` ignorá-lo, use `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

Os testes de integração com o ai-memory (`tests/integration-ai-memory.test.ts`) sobem um servidor real isolado, com pasta temporária, token e porta aleatória. Eles rodam quando há um binário em `AI_MEMORY_BIN` ou `ai-memory` no PATH; caso contrário, são pulados.

Release: `npm run release -- 0.5.0 --push` atualiza a versão, fecha a seção do CHANGELOG, cria `docs/releases/v0.5.0.md`, faz o commit e envia a tag. O workflow **Release** testa, gera o AppImage e publica a release com o AppImage, o checksum e o `install-linux.sh`. Use `--dry-run` para conferir antes.

Diagnóstico: em Configurações › Diagnóstico, ou em `GET /api/diagnostics`. O relatório traz versões, caminhos (com a home como `~`) e estado dos serviços, sem credenciais nem conversas.

Os testes E2E (`tests/e2e/`) sobem o backend e o build reais com um provedor simulado, em uma pasta de dados temporária e sem acessar o ai-memory nem os CLIs do computador.

Banco de dados: o esquema é versionado em `PRAGMA user_version` (`server/migrations.ts`). Antes de aplicar uma migração numa base com dados, o Adelic grava uma cópia em `<pasta de dados>/backups/` (permissão 0600, as cinco mais recentes). Uma base criada por uma versão mais nova do Adelic é recusada sem alterações. Para restaurar uma cópia, feche o Adelic e substitua `adelic.sqlite` por ela, removendo `adelic.sqlite-wal` e `adelic.sqlite-shm`.

Organização: `server/index.ts` monta o app, e as rotas ficam em `server/http/` (projetos, conversas, configurações e memória). No front, `src/App.tsx` guarda o estado e a composição, e as telas e partes estão em `src/components/`. Os corpos das requisições são validados com zod em `shared/schemas.ts`. Cada tela fica dentro de um error boundary: um erro de renderização mostra a mensagem e permite tentar de novo, sem derrubar o restante da janela.

Os [requisitos](docs/specs/requirements.md), [design](docs/specs/design.md) e [tarefas](docs/specs/tasks.md) documentam este incremento. A [pesquisa de baseline](docs/baseline.md) compara as referências e os passos futuros. Veja os [testes reais e limites da validação](docs/validation.md).

O incremento de delegação e contexto está especificado em [orquestração e Graphify](docs/specs/orchestration.md). Com a orquestração ligada, o seletor de agente/modelo da conversa configura o coordenador; executor e revisor têm suas próprias opções por projeto. Saídas detalhadas ficam nas tarefas persistidas e não são carregadas integralmente no contexto do coordenador. Leituras independentes podem ocorrer em paralelo; execuções com permissão de escrita são serializadas no projeto.

O fluxo de chats avulsos e o tema escuro estão em [conversas](docs/specs/conversations.md).

O polimento de atividade e o controle de thinking estão em [uso do chat](docs/specs/chat-usability.md). A disponibilidade de ferramentas locais no caminho rápido está em [ferramentas rápidas](docs/specs/fast-local-tools.md). O checkout de desenvolvimento pode gerar versões locais posteriores à release disponível no GitHub. O layout do rodapé está em [controles do chat](docs/specs/composer-layout.md), o tema e os padrões de interface em [tema e interface](docs/specs/visual-theme.md), e os próximos testes pelo próprio aplicativo em [dogfooding](docs/dogfooding.md).

`master` contém a versão estável; `develop` recebe os próximos incrementos. Tags `vX.Y.Z` identificam as releases. A v0.1.0 começa com os dois branches no mesmo commit.
