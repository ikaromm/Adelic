# Memória com ai-memory em Docker — 2026-10-06

Pedido do usuário: a biblioteca de memórias deve usar a mesma fonte do servidor ai-memory também quando ele roda em Docker, com dados no volume `ai-memory-data`, sem conceder acesso a `/var/lib/docker`. Contrato em [memória compartilhada](specs/shared-memory.md).

- Capacidades verificadas no binário 2.1.0 instalado e no código das tags v2.1.0 e v2.5.2: o MCP não lista escopos. A API somente leitura `/api/v1` (`--enable-web`, padrão na imagem Docker) lista projetos, contagens e notas, e `/admin/write-page` reescreve notas com `kind`. A comparação do frontmatter de todas as notas reais com a regra OKF de `type` não encontrou divergências.
- `server/memory-catalog.ts` (SQLite) e `server/memory-local-writer.ts` (Markdown local) foram removidos. Catálogo, listagem e verificação de caminho usam `/api/v1`. Leitura, busca e criação usam MCP. A edição usa `/admin/write-page`, ou `memory_write_page` quando a nota tem TTL, só quando o writer reproduz todo o frontmatter. A versão é conferida antes e depois de gravar.
- Instância ai-memory 2.1.0 isolada, em pasta temporária na porta 49399, com `AI_MEMORY_AUTH_TOKEN`, como num contêiner com token. O Adelic recebeu o token por `ADELIC_MEMORY_TOKEN_FILE`. Resultados:
  - Catálogo e paginação iguais ao serviço; busca restrita ao escopo.
  - Edição de nota Fact com tags, pin, tier procedural e título, de nota simples e de nota com TTL: metadados idênticos depois de salvar e corpo confirmado.
  - Alteração externa retornou 409 e foi mantida. Criação funcionou; criação sobre caminho existente retornou 409.
  - Nota com campo personalizado retornou 422, com o hash do arquivo inalterado.
  - Escopo inexistente retornou 404. Sem token: 503 com a explicação. Serviço parado: 503 com o endereço.
  - O token não apareceu no log nem no ambiente do processo.
- Instalação nativa deste computador (porta 49374), apenas leitura: catálogo com 195 notas em 11 escopos, igual a `pages_latest` de `/admin/status`. A listagem de cada escopo bate com a contagem. Das 195 notas, 194 são editáveis pela regra; a outra é do escopo `_global`, que é somente leitura. A busca funcionou.
- Não testado: um contêiner Docker de verdade. O usuário não tem acesso ao `docker.sock`, e o ai-memory deste computador roda pelo systemd. A instância isolada usa o mesmo binário e a mesma configuração de token da imagem.

# Interface baseada no T3 Code e tema Dracula escuro — 2026-10-06

Pedido do usuário: validar a UI/UX, usar o T3 Code como base e aplicar um tema inspirado no Dracula, mais escuro. Contrato em [tema e interface](specs/visual-theme.md). Desenvolvimento local após a v0.2.0, sem novo pacote, commit ou publicação.

- Referência: código-fonte local do T3 Code 0.0.44 (`apps/web/src`), lido por um subagente somente leitura. O serviço T3 local exigiu pareamento; só a página inicial foi carregada, sem alterações.
- Divisão do trabalho: o coordenador escreveu tokens, base, TSX, spec e QA; três codificadores GPT-6 Luna (Codex CLI, `workspace-write`) escreveram `shell.css`, `chat.css` e `pages.css` em escopos exclusivos, sem tocar outros arquivos (status e hashes conferidos). GPT-6 Sol e GPT-6 Astra revisaram em `read-only`: nenhum bloqueador; os achados MAJOR/MINOR (rolagem com aprovação nova, nome acessível das pílulas, Home/End na busca, foco fora da área visível, expansão do resumo, títulos h5/h6 abaixo de 11 px, tabela de Atividade recortada em largura intermediária, breadcrumb, movimento reduzido e dois literais de cor) foram corrigidos e verificados depois.
- Auditoria com Chromium headless (CDP) em servidor de desenvolvimento no loopback e cópia temporária da base real; uma conversa sintética com execução ativa, streaming, aprovação pendente, erro, código e tabela foi inserida apenas nessa cópia. Antes: 38–85% dos textos visíveis abaixo de 11 px e até três textos habilitados abaixo de AA por tela. Depois: **0 textos abaixo de 11 px e 0 textos habilitados abaixo de AA** em 12 telas auditadas (chat, atividade aberta, menus, Configurações, Atividade, Memória, modal e estados sintéticos), sem rolagem horizontal em 390, 960, 1024 e 640×360.
- Matriz automática: larguras 360–1440 px, alturas 360/568/800 e barra recolhida acima de 820 px — **42 combinações × 4 menus, zero falhas**: enviar visível, sem overflow, menus dentro da viewport e colados ao acionador, foco interno, Escape fecha e devolve o foco. Interações conferidas: campo de mensagem cresce de 48 a 240 px e rola depois disso; setas/End nos menus; menu fecha ao perder o foco; Home/End mantêm o cursor na busca; copiar com clique real usou o fallback; ir para a mensagem mais recente; gaveta móvel fechada fora do foco e fechada por Escape.
- Fontes Inter e JetBrains Mono incluídas no build; o Linux exibia Liberation Sans antes porque as fontes declaradas não estavam instaladas.
- `npm run typecheck`, `npm run build` e **191 testes em 20 arquivos** passaram com TMPDIR padrão. Novos testes cobrem duração/tempo relativo/atalho, lista da barra lateral e prévia de comandos. Com `TMPDIR` dentro do repositório, testes de Graphify e providers falham também numa cópia limpa do HEAD (7 falhas: os scripts falsos herdam `"type": "module"`), portanto não decorrem desta mudança.

Limites: Chromium headless do sistema, não o Electron empacotado, o preview T3 ou um dispositivo físico; o AppImage não foi regenerado nem reinstalado; leitor de tela e zoom de 200% não foram testados interativamente. A base real só foi lida para a cópia (`sqlite3 .backup`); ao fechar, o SQLite fez o checkpoint normal do WAL no arquivo principal, sem mudar o conteúdo (quick_check ok; 32 conversas, 130 mensagens, 65 runs, nenhuma linha de QA). Para cópias futuras, abrir com URI `mode=ro` evita esse checkpoint. A cópia e os dados sintéticos ficaram em pasta temporária, removida ao final.

---

# Validação v0.2.0 — 2026-10-06

Implementação de produção enviada pelo próprio Adelic a GPT-6 Luna; revisões independentes Sol/Astra sem bloqueadores após as correções. O coordenador escreveu specs/documentação e verificou integração, preview, runtimes e distribuição. Dados operacionais e notas pessoais ficaram fora do Git.

- Typecheck, build e **182 testes em 19 arquivos** passaram no host, sem overrides de TMPDIR. Inclui testes reais bubblewrap, concorrência HTTP, shell/identidade local, preservação de metadados, cancelamento com árvore de subprocessos e execução irmã preservada.
- Preview T3: modelos/efforts dinâmicos, Sol/Ultra→Luna/Auto, drafts por conversa, foco/Escape, menus dentro de 360×320 e 1280×800; memória tela→CLI e CLI→polling, conflito/rascunho e falha 503 com recuperação; duas corridas de Settings reproduzidas e corrigidas. Captura/clique físico falharam no cliente T3; entrada literal, handlers DOM, geometria e APIs foram usados, sem afirmar screenshot ou dispositivo físico.
- Codex 0.160 real com runtime exclusivo final: 2+2 respondeu 4 em **5.208 ms**, um worker/low, sem comandos/memória/grafo. uname -a executado com aprovação automática em **3.992 ms**. Programa Python mínimo retornou 42 após confirmação do comando composto; rm negado preservou arquivo sintético. Tempos são amostras, não SLA.
- Tentativa controlada de escrita fora da pasta foi aprovada e falhou com filesystem somente leitura; o arquivo não foi criado. Cancelar Python duradouro marcou cancelled e encerrou o PID real em **105 ms**, sem aprovações pendentes. O teste de siblings verifica independência no mesmo cwd. Encerramento usa prazo máximo, sem garantia universal para condições do sistema operacional.
- ai-memory 2.1.0: nota Fact sintética preservou todo YAML byte a byte, incluindo campo personalizado; watcher encontrou novo corpo, save antigo retornou 409. Notas de QA removidas; 194 notas preexistentes preservadas antes da atualização final das próprias notas de estado. Edição local não oferece CAS entre processos, hooks/RBAC/autoria ou checkpoint Git.

AppImage **Adelic-0.2.0-linux-x86_64.AppImage**, **117.381.619 bytes**, SHA-256 `c1b8c0f65dbc0442e8d7ac488ec9a31f16b7b92893a38506aebab9d208420a5a`. Electron 44.5.1 / Node 24.21.0. ASAR auditado: 10 entradas, sem node_modules, bancos, notas ou credenciais. Smoke do pacote com cwd externo e PATH inicial /usr/bin:/bin: DOM/API/SQLite, segunda instância, encerramento e reabertura com histórico passaram.

Inferência no pacote instalado: Codex/Luna respondeu 4 para 2+2 em **2.935 ms**, um executor/low, sem comandos/memória/grafo. Isso valida também o runtime empacotado, além do backend de desenvolvimento.

Instalação local atualizada: launcher `adelic`, janela nativa mapeada, API loopback respondeu 200 e SQLite íntegro. Snapshot/hash de todas as linhas das sete tabelas de histórico permaneceu igual antes/depois: 31 conversas, 128 mensagens, dois projetos, 64 runs, 80 tarefas, 1.801 eventos e 19 aprovações. Configuração de execução restaurada para somente leitura e memória automática desligada. Backup da base foi criado antes de trocar o executável. Compatibilidade validada nesta versão: Arch/Omarchy x86_64 com Wayland; outras distribuições, Claude Pro/Max e execução OpenCode permanecem pendentes.

Detalhes e bugs encontrados em [dogfooding](dogfooding.md); limites de comandos em [política](specs/safe-command-approvals.md); distribuição em [desktop Linux](desktop-linux.md).

---

# Validação do incremento local

## UI pelo próprio Adelic — 2026-10-05

Build local **0.1.1-dev.2**. O usuário pediu testes em projetos pequenos/mini fixes usando o próprio aplicativo; o primeiro caso foi limpar o chat e mover controles para o rodapé. Pedidos enviados pelo preview T3 ao desktop instalado, projeto Adelic real. Sol planejou os escopos JSX/CSS, Luna implementou, Astra revisou; correções adicionais também passaram pelo Adelic. O orquestrador externo escreveu a spec, preservou o checkout, reproduziu os defeitos no browser e fez integração/empacotamento. Não foi um teste feito apenas com stubs ou um CLI de modelo externo.

- Histórico desta conversa registra **seis turnos e dez chamadas de tarefas**: dois Sol, seis Luna e dois Astra. O primeiro pipeline teve cinco fases e levou **366.653 ms**; correções rápidas usaram um executor, sem planejamento/grafo, e levaram entre **10.700 e 82.513 ms**. A revisão final Astra foi uma tarefa readonly rápida de **63.289 ms**. Isso é uma amostra de trabalho, não benchmark. Os escopos de escrita ficaram separados e dependentes, sem escrita concorrente no mesmo arquivo.
- Removidas toolbar e faixas repetidas do topo. Agente/modelo/thinking junto ao campo de mensagem; projeto/modo/configuração nas opções inicialmente recolhidas. Cancelar e aprovar continuam acessíveis. A primeira revisão Astra encontrou Ajuda escondida e envio fora de 360×320; ambos foram reproduzidos. A primeira correção de altura ainda falhou; o teste de foco detectou também a soma indevida de scroll-padding/scroll-margin. Todas essas correções de código foram solicitadas e realizadas pelo Adelic. A revisão final estática não encontrou novos blockers; o problema de foco foi integrado após a medição visual.
- Preview T3, iframe de mesma origem: **192 combinações** de larguras 360, 388, 620, 621, 820, 1.040, 1.280 e 1.500 px; alturas 320, 568 e 800 px; sidebar expandida/recolhida, opções abertas/fechadas e faixa de execução simulada. Zero casos com overflow horizontal, envio/controles primários fora do viewport, Ajuda escondida ou foco coberto pelo summary. Thinking teve no mínimo 89 px úteis. Simulação da faixa testa geometria, não lifecycle; não é dispositivo físico. Só o iframe desativou transições e animacões; os estilos experimentais foram removidos antes da matriz final.
- Fluxo real pela UI em uma cópia temporária da base: thinking médio e Rápido persistiram; cálculo Codex/GPT-6 Luna retornou **72** em **2.434 ms**, com um executor e sem comandos/memória/grafo. Vínculo/desvínculo preservou as duas mensagens; troca Kiro→Codex limpou o modelo anterior e manteve thinking. Durante execução, os três seletores estavam bloqueados e Cancelar disponível. Um comando Python de espera foi cancelado pela tela; run e tarefa ficaram cancelados, sem aprovação pendente, controles reabilitados e atividade recolhida indicando Cancelada. O Python ainda existia na checagem imediatamente seguinte e desapareceu após encerrar o backend de QA; este teste não comprovou o prazo de encerramento do subprocesso. Precisa de investigação própria.
- `npm test`: **110 testes em 13 arquivos**, todos passaram no host; typecheck, build e diff-check passaram. Dentro do runtime o executor relatou `ENOENT` ao criar SSR em `/tmp` antes das suítes iniciarem. A causa exata e a execução confiável dos testes pelo runtime continuam pendentes. Nenhuma permissão foi ampliada para contornar isso. Aprovações não foram provocadas neste mini fix; o fluxo anterior continua coberto pelas regressões existentes.

`npm run package:linux` gerou `release/Adelic-0.1.1-dev.2-linux-x86_64.AppImage`, **117.373.432 bytes**, SHA-256 `3cb86b00106c115848305a9db43558fc229ea971a754f33e37cc05bf3a39b4cb`. ASAR final com 10 entradas, sem dependências node_modules, SQLite ou credenciais. Checksum e smoke Linux passaram: Electron 44.5.1/Node 24.21.0 em Arch/Omarchy x86_64, fora do repo, PATH inicial sem Node/npm, segunda instância, encerramento e reabertura com histórico/DOM/API.

Instalação local atualizada com zero execuções ativas, backup SQLite, binário de checksum idêntico, janela nativa mapeada e API em loopback. Todas as linhas pré-existentes de conversas/mensagens/runs/tarefas/eventos/aprovações foram comparadas e preservadas desde o início do trabalho. Antes/depois da instalação, as sete tabelas ficaram integralmente idênticas: **24 conversas, 60 mensagens, dois projetos, 30 runs, 38 tarefas, 267 eventos e 19 aprovações**, quick_check ok. A nova conversa de implementação fica no histórico real; QA funcional ficou na cópia temporária. Escrita foi habilitada durante a implementação autorizada e voltou ao readonly anterior; projeto Adelic ficou com Luna executor e Astra revisor. Artefatos anteriores mantiveram seus checksums. Sem commit, push ou nova publicação. Próximos casos e pendências em [dogfooding](dogfooding.md).

## Ferramentas rápidas — 2026-10-05

Build local **0.1.1-dev.1**. A decisão do usuário permite ferramentas locais em Auto rápido e Rápido explícito, sem acrescentar chamadas de planejamento, memória ou grafo. Luna implementou roteamento e runtimes em escopos separados; Sol e Astra fizeram revisões independentes. Uma asserção incorreta de argumentos foi corrigida. A integração manteve o orçamento curto do executor e conferiu o fluxo real.

- `npm test`: **110 testes em 13 arquivos**, todos passaram. `npm run typecheck`, `npm run build` e `git diff --check` passaram. Regressões verificam um executor, ausência de memória automática, disponibilidade de ferramentas, eventos reais, rejeição honesta de runtime incapaz, perfis Codex separados e ferramentas desabilitadas nas chamadas internas. Aprovações, sandbox e reservas de escrita continuam sujeitos à política anterior.
- Inferências reais em base temporária, somente leitura, todas com um executor e sem memória/grafo: Codex/GPT-6 Luna, Auto/baixo, respondeu **72** para 8 × 9 em **4.898 ms**, sem ferramentas; Codex/GPT-6 Luna, Rápido/médio, executou `command -v wpctl; wpctl status` e respondeu com o estado real do PipeWire em **6.795 ms**, com uma ação registrada; Kiro/GPT-5.6 Luna, Rápido/médio, leu um arquivo temporário e devolveu seu marcador exato em **3.785 ms**, com uma ação de leitura. O arquivo permaneceu igual e nenhum índice de grafo foi criado.
- O teste real detectou que desligar `code_mode_host` no Codex CLI 0.160.0 prejudicava a execução. O perfil rápido agora habilita explicitamente esse host, shell e unified exec no processo e na thread; o perfil interno sem ferramentas mantém os três desligados. Nenhuma configuração global do Codex foi alterada.
- A pergunta natural sobre microfone, com thinking baixo, também produziu respostas que só ofereciam ou anunciavam consultas, sem eventos de ferramenta. Disponibilidade não garante que o modelo escolherá uma ação em todo pedido; o teste efetivo de comando acima utilizou pedido explícito e thinking médio. Não considerar intenção na resposta como execução nem concluir que o problema do microfone foi resolvido. Não houve captura de áudio ou alteração de configurações.
- Preview T3 mostrou as respostas reais e a atividade recolhida junto ao pedido: **1 tarefa e 1 ação** para a consulta Codex e a leitura Kiro, thinking médio preservado e sem overflow horizontal. O build instalado preserva Automático/Baixo/Médio/Alto e a conversa antiga do microfone; seu turno antigo conserva a política histórica. A matriz de 24 layouts do incremento anterior continua registrada abaixo; não foi repetida para este ajuste de disponibilidade e texto de ajuda.

`npm run package:linux` gerou `release/Adelic-0.1.1-dev.1-linux-x86_64.AppImage`, **117.373.457 bytes**, SHA-256 `3100ea8ebf60026b6960e53a9177740b9c4334fcb74b82187d46dfd667b3e008`. Checksum conferido; `app.asar` final contém 10 entradas, sem `node_modules`, SQLite ou credenciais. Electron 44.5.1/Node incorporado 24.21.0 em Arch/Omarchy x86_64. `npm run desktop:smoke` passou no artefato final, incluindo execução fora do repo sem Node/npm no PATH inicial, segunda instância, shutdown e reabertura com histórico, DOM e API válidos.

A instalação local foi atualizada após confirmar zero execuções ativas e criar backup SQLite. Binário instalado com checksum idêntico ao pacote, janela nativa mapeada e API em `127.0.0.1` verificadas. Comparação integral das sete tabelas antes/depois preservou **23 sessões, 48 mensagens, dois projetos, 24 execuções, 28 tarefas, 157 eventos e 19 aprovações**; SQLite `quick_check` retornou `ok`. QA permaneceu em dados temporários separados. Artefatos v0.1.0 e 0.1.1-dev.0 conservaram seus checksums; este incremento não foi publicado no GitHub. Claude e OpenCode continuam sem inferência validada aqui; as ferramentas disponíveis dependem também da integração e das permissões de cada runtime. Tempos acima são amostras individuais, não benchmark.

## Chat e thinking — 2026-10-05

Build local **0.1.1-dev.0**, posterior à release publicada v0.1.0. Dois codificadores GPT-6 Luna separaram UI e backend; GPT-6 Sol revisou concorrência/propagação e GPT-6 Astra revisou histórico, estados e lifecycle de ferramentas. Os bloqueadores encontrados foram corrigidos e os deltas revisados. O orquestrador integrou contratos, documentação, validação de interface e instalação.

- `npm test`: **107 testes em 13 arquivos**, todos passaram; `npm run typecheck`, `npm run build` e `git diff --check` passaram. Doubles conferem esforço explícito nas fases delegadas, protocolo Codex, validação atômica, persistência, reserva durante descoberta, retries e cancelamento. Regressores também cobrem mais de 30 tarefas sem saída no snapshot, chamadas de comando distintas e updates parciais Kiro que preservam título/tipo. Isso não substitui inferência real em cada runtime/modelo.
- Preview T3 conectado ao build instalado: a conversa dos dois programas mostra **uma linha de 32 px**, recolhida, com cinco tarefas e 15 ações, junto ao pedido. Ao expandir, cinco resumos e 12 comandos continuam recolhidos individualmente; a saída completa foi buscada somente ao clicar e permaneceu acessível. Turno antigo cancelado sem tarefas indica Cancelada mesmo fechado. Thinking oferece Automático/Baixo/Médio/Alto; os quatro valores foram persistidos pela interface e conferidos pela API em uma cópia temporária da base.
- Responsividade conferida no preview com iframe de mesma origem: **24 combinações**, larguras efetivas de 360, 388, 620, 621, 820, 821, 840, 860, 1.040, 1.100, 1.280 e 1.500 px, com estilos de sidebar aberta/recolhida. Seletores e modo ficaram dentro da toolbar, sem overflow horizontal; Thinking teve 90–240 px úteis. As transições foram desativadas somente no iframe de teste. O ajuste considera a largura disponível no main e viewport fracionária durante zoom. Não é teste em dispositivo físico; resize do preview apresentou falhas.

Inferências reais pela API de desenvolvimento, somente leitura, em dados temporários; cada execução concluiu com um executor, sem ferramentas, memória ou grafo:

| Runtime/modelo | Thinking | Resultado | Duração |
| --- | --- | --- | --- |
| Codex / GPT-6 Luna | baixo | 8 × 9 = 72 | 4.121 ms |
| Codex / GPT-6 Luna | médio | 11 × 12 = 132 | 4.031 ms |
| Codex / GPT-6 Luna | alto | 13 × 14 = 182 | 8.091 ms |
| Kiro / GPT-5.6 Luna | médio | 15 × 16 = 240 | 2.329 ms |

São amostras individuais, não um benchmark de latência. Claude Pro/Max permanece sem inferência validada neste computador; OpenCode permanece indisponível para execução. Catálogo conhecido limita as opções; catálogo sem esforços publicados não comprova todos os níveis para todos os modelos.

`npm run package:linux` gerou `release/Adelic-0.1.1-dev.0-linux-x86_64.AppImage`, **117.373.539 bytes**, SHA-256 `e81474ee218e6cd9d7c1272df6673016613c143dda4e8667ca67c31458fc4961`. Checksum conferido; `app.asar` final tem 10 entradas e nenhum `node_modules`, SQLite ou configuração de credenciais. Electron 44.5.1/Node incorporado 24.21.0, host Arch/Omarchy x86_64. `npm run desktop:smoke` passou no artefato final: pasta fora do repo, PATH inicial sem Node/npm, segunda instância encaminhada, shutdown com backend/porta encerrados e reabertura com histórico/DOM/API válidos.

A instalação deste usuário foi atualizada pelo instalador, após confirmar zero execuções ativas e fazer backup SQLite local. O binário instalado tem o mesmo SHA-256 do pacote; janela nativa mapeada e API em loopback verificadas. Todos os registros das tabelas de histórico foram comparados integralmente antes/depois: **23 sessões, 48 mensagens, dois projetos, 24 execuções, 28 tarefas, 157 eventos e 19 aprovações**, sem alteração. SQLite `quick_check` retornou `ok`. As conversas de QA permaneceram somente na base temporária. A release/artefato v0.1.0 manteve seu checksum original; este incremento não foi publicado no GitHub.

## Registros anteriores à v0.1.0

Data: 2026-10-04. Os registros abaixo descrevem os testes locais anteriores à publicação da v0.1.0. O modo web usa `http://127.0.0.1:4317`; o desktop escolhe uma porta livre. Ambos escutam somente no loopback. As [notas da versão](releases/v0.1.0.md) descrevem os artefatos distribuídos.

## Conversas avulsas, tema escuro e programas pequenos

Na etapa de conversas avulsas: `npm test` passou com **60 testes em seis arquivos**; `npm run typecheck` e `npm run build` também passaram. Codificadores Luna separaram backend, UI e CSS. Revisões independentes somente leitura por GPT-6 Sol e GPT-6 Astra foram executadas pelo Codex CLI; o limite de threads impediu criar um novo agente de tema, então o agente Luna anterior foi reutilizado. Astra não encontrou bloqueadores no backend. Sol apontou contraste insuficiente e um snapshot atrasado que poderia substituir o chat recém-criado; ambos foram corrigidos e conferidos no preview.

A migração foi aplicada ao SQLite real após backup local. Todos os registros anteriores de projetos, sessões, mensagens, execuções, eventos, aprovações, tarefas e resumos foram preservados; `foreign_key_check` não encontrou inconsistências. Sessões e tarefas aceitam `projectId: null`. Novos testes cobrem migração preenchida, vínculo/desvínculo atômicos, rejeição durante execução, workspace avulso, ausência de memória/grafo de outro projeto e cancelamento por sessão.

No preview T3: o + de Adelic criou uma thread vinculada; o botão global e Ctrl+K abriram avulsas mesmo com o projeto selecionado. O seletor anexou e desvinculou uma conversa já respondida, mantendo suas duas mensagens. Após recarga, a saída de sua tarefa avulsa continuou carregável mesmo com a conversa anexada a Adelic. Um refresh SSE foi acionado com a resposta de health deliberadamente retida; criar uma nova conversa e depois liberar o snapshot anterior preservou a nova seleção. A instrumentação de fetch/EventSource foi restaurada após o teste.

Tema escuro conferido em chat e tela inicial, com `color-scheme: dark` e paleta aplicada a todos os painéis/controles. O texto de ações roxas usa `#171725` sobre `#9290f4`, contraste calculado de 6,34:1 (5,62:1 no hover). Iframes de mesma origem com 360 e 388 pixels mostraram os quatro seletores em grade 2×2, sem transbordamento horizontal e com selects de 109–144 pixels, evitando o encolhimento encontrado no primeiro teste. Não é teste em dispositivo físico.

| Execução real | Evidência |
| --- | --- |
| Kiro, conversa avulsa: 12 × 13 | Resposta 156; um executor GPT-5.6 Luna; nenhuma ferramenta/memória; 2,46 s |
| Codex, projeto: somador Node.js e palíndromo Python | Planejador GPT-6 Sol, dois executores GPT-6 Luna, revisor GPT-6 Sol e síntese; cinco tarefas concluídas; escrita dos quatro arquivos e testes reais registrados |
| Codex, conversa avulsa: criar e executar hello.py | Quatro tarefas concluídas, workspace próprio, nenhuma memória/grafo de projeto, saída 42 com newline; 64,06 s; anexar projeto durante execução retornou 409 |

O somador teve **7/7 testes aprovados**, incluindo decimal/negativo, ausência de argumentos, valores inválidos e overflow. O palíndromo teve **6/6**, incluindo Unicode e erro de uso. O revisor leu os arquivos e repetiu os dois comandos em somente leitura, com cinco verificações adicionais; o orquestrador repetiu os testes externamente e confirmou os resultados e o README original. O pipeline levou 190,22 s, sem aprovação manual pendente. Escritas dos dois executores foram serializadas conforme a política do aplicativo; esse teste não comprova escrita paralela nem latência fixa.

Os programas foram criados em uma pasta local de validação sob `~/.local/share/adelic/smoke-projects/`. Comandos usados: `node --test sum.test.mjs` e `python3 -B -m unittest -v test_palindrome.py`. A conversa avulsa com `hello.py` usa `~/.local/share/adelic/conversations/<id-da-conversa>/`. Nenhuma dependência externa foi instalada. Permissão de escrita foi capturada somente no início dos smokes e restaurada para somente leitura imediatamente depois; memória automática permanece desligada.

## Orquestração e Graphify por projeto

Verificação final: `npm run typecheck`, `npm test` (50 testes em seis arquivos) e `npm run build` passaram. O build final está servido por `npm start` no loopback. A revisão independente de Sol cobriu contexto de memória, skills, paralelismo, persistência e carregamento de saída; os ajustes finais de classificação e caminhos foram conferidos pelo orquestrador, regressões e smokes reais. Astra revisou pelo Codex CLI em modo somente leitura; seus achados de recuperação após cancelamento do índice, detecção de mudanças e preservação de saída integral foram corrigidos.

Projetos novos e existentes sem configuração explícita começam com delegação e Graphify ativados. O coordenador é o agente/modelo da conversa; executores e revisores herdam seu provedor, com modelos compatíveis selecionados do catálogo real. No Codex, a preferência é GPT-6 Luna/GPT-6 Sol; no catálogo Kiro deste computador, foram usados GPT-5.6 Luna/GPT-5.6 Sol. Perguntas simples têm somente uma chamada de executor, sem ferramentas, planejamento, grafo ou busca automática de memória.

| Fluxo real | Resultado verificado |
| --- | --- |
| Kiro: 7 × 8 | Um executor GPT-5.6 Luna, resposta 56, sem ferramentas/memória; 2,44 s |
| Codex: 9 × 9 | Um executor GPT-6 Luna, resposta 81, sem ferramentas/memória; 6,49 s |
| Kiro: ler README.md | Um executor; leitura registrada e linhas confirmadas; 10,07 s |
| Kiro: recuperar decisão sobre Graphify | Uma chamada de executor, rota com memória e sem ferramentas/grafo; decisão correta; 10,83 s |
| Kiro: duas partes independentes | Planejador, dois executores, revisor e síntese; cinco tarefas concluídas, consultas Graphify e leitura de código registradas |
| Kiro: ler server/router.ts pelo caminho explícito | Auto habilitou leitura com um executor; código e testes consultados, escopo/mapa com 13 caminhos reais; 16,50 s |

Os dois executores independentes começaram com 13 ms de diferença, antes de qualquer um terminar. O fluxo completo levou 149,03 s, incluindo espera por aprovação manual e correção de um caminho digitado incorretamente pelo executor. Esse tempo não representa latência sem interação. A revisão conferiu fontes; a síntese usou resultados compactos. Saídas completas dos cinco papéis foram recuperadas individualmente pela API. A resposta da conversa e a visão de coordenação não incluem essas saídas integralmente.

Graphify existente (`graphifyy 0.9.68`) foi executado de fato, sem instalação global adicional: extração AST com `--code-only --no-cluster --max-workers 2`, consulta com orçamento de 800 tokens. A primeira indexação pela tela produziu 373 nós/1.053 relações; o índice foi atualizado depois das mudanças de código. O cache final fica em `~/.local/share/adelic/graphs/<hash-do-caminho>/graphify-out/graph.json`. `GRAPHIFY_OUT` no subprocesso também direciona o cache auxiliar de metadados para essa pasta; os caches experimentais criados no repositório foram removidos. A camada semântica de documentos não foi indexada.

Pelo preview T3, indexação, consulta, desligar/ligar Graphify e limpar provedor/modelo para herdar a conversa funcionaram, com confirmação posterior pela API. A tela mostrou as cinco tarefas concluídas do pipeline e carregou uma saída completa sob demanda. Configurações de orquestração/Graphify foram verificadas em larguras efetivas de 360 e 388 pixels por iframe de mesma origem, sem transbordamento; não foi teste em dispositivo físico.

O botão de cancelamento encerrou uma execução delegada real, marcou executores em andamento e tarefas na fila como cancelados e resolveu todas as aprovações pendentes. Tarefas já concluídas permaneceram concluídas. Reinícios posteriores preservaram os registros. Memória automática foi ativada apenas durante seu smoke e restaurada para desligada; a política permanece somente leitura.

As regressões novas cobrem limites e dependências do plano, herança de provedor/modelo, contexto completo do pedido e resumos limitados, recuperação/cancelamento dos filhos, serialização e reserva de escrita por projeto, uso sem contagem dupla, memória seletiva e falha/ausência de notas sem inventar decisões, saída sob demanda, exportação e remoção de tarefas, Graphify desatualizado/cancelado e caminhos reais `src=`. Mudanças detectadas durante indexação/consulta impedem enviar o recorte como atual. Inspeção por metadados pode ser mais lenta em árvores muito grandes; não há benchmark de redução percentual de tokens.

## Registros da etapa inicial

As evidências abaixo são anteriores ao incremento de delegação e Graphify. Permanecem como histórico de validação dos runtimes, permissões, memória e interface inicial.

## Verificação automatizada

`npm run typecheck`, `npm test` e `npm run build` passaram após as correções finais: 26 testes em quatro arquivos. `npm audit --omit=dev` não encontrou vulnerabilidades. O build gera `dist/`; `npm start` serve esse build localmente.

Na entrega, o servidor de desenvolvimento foi encerrado e o build foi iniciado com `npm start`. HTML e health retornaram 200; Codex, Kiro e memória disponíveis. O histórico e a resposta final sobreviveram à troca de processo. O servidor de produção local permanece aberto para teste.

A suíte cobre roteamento por intenção, perguntas conceituais que devem continuar rápidas, contexto/skills pertinentes, idempotência, exclusão de execuções simultâneas, recuperação após reinício, captura de permissões no começo do turno, aprovação/cancelamento, limites de histórico, descoberta real de configuração MCP e lifecycle dos adaptadores. Há regressões para inicialização concorrente, cancelamento durante inicialização, morte do app-server Codex, permissões solicitadas e alinhamento entre projeto e conversa após respostas atrasadas. Os doubles verificam protocolos; não substituem as execuções reais abaixo.

## Execuções reais

Pedidos foram enviados pelo chat do preview T3 e pela API local. Dados foram conferidos novamente pela API após cada execução. A memória automática estava desligada, o modo padrão era Auto e o filesystem somente leitura.

| Runtime/modelo | Pedido | Rota | Primeiro texto | Duração | Evidência |
| --- | --- | --- | --- | --- | --- |
| Codex / GPT-6-Luna | Quanto é 7 × 8? | Rápido | 9,06 s | 9,56 s | Resposta 56; nenhuma ferramenta ou busca de memória |
| Codex / GPT-6-Luna | Ler e resumir README.md | Completo | 9,72 s | 11,26 s | Comando `cat README.md` registrado; resumo do conteúdo real |
| Kiro / GPT-5.6-Luna | Quanto é 7 × 8? | Rápido | 2,14 s | 2,26 s | Resposta 56; nenhuma ferramenta ou busca de memória |
| Kiro / GPT-5.6-Luna | Ler e resumir README.md | Completo | 2,98 s | 6,26 s | Leitura de README registrada e concluída; resumo do conteúdo real |

São amostras individuais, sujeitas ao provedor, modelo, carga do computador e inicialização. O requisito comprovado é retirar trabalho adicional do caminho simples; não há promessa de latência fixa. Uma execução Codex anterior, com modelo padrão e perfil anterior às correções finais, levou 4,59 s e não constitui benchmark da configuração final.

Uma conversa nova Codex forçada para Rápido recebeu um pedido de leitura de arquivo: respondeu que não tinha acesso aos arquivos, sem adivinhar o título e sem registrar ferramentas (3,55 s no total). Isso valida o limite do modo mesmo diante de um pedido que normalmente acionaria ferramentas.

Uma resposta longa do Kiro foi recarregada durante o streaming. A interface recuperou o texto persistido e mostrou o botão de cancelamento. O cancelamento pela tela encerrou o processo, preservou a resposta parcial (19.678 caracteres) e deixou o turno com status `cancelled`, sem evento de erro fictício. O pedido seguinte, 9 × 9, completou com resposta 81 em 2,42 s, sem ferramentas. Um cancelamento Codex antes da inicialização também foi verificado durante a integração; a correção final desse fluxo está coberta pelas regressões.

## Interface, memória e persistência

- Preview T3: chat, criação de conversa, escolha de modelo, alternância de modos, streaming, cancelamento, atividade, configurações e memória inspecionados. O histórico permaneceu após recargas e reinícios do servidor durante a integração.
- Layout estreito testado em iframe de mesma origem, com larguras efetivas de 360 e 388 pixels e media queries ativas, sem transbordamento horizontal. O controle de resize do preview falhou; esse teste não equivale a teste em dispositivo físico.
- Resposta PATCH deliberadamente atrasada: trocar de conversa enquanto a resposta chegava preservou o agente e o modo da conversa selecionada. O desalinhamento adicional de bootstrap encontrado por Astra foi corrigido por Sol e coberto por três regressões de seleção.
- ai-memory: pesquisa, leitura completa de página e gravação pela tela passaram no escopo explícito workspace/project configurados para o teste; a nota foi lida novamente pela API. A memória pessoal foi mantida em seu escopo separado.
- SQLite em `~/.local/share/adelic/adelic.sqlite`; dados de runtime e credenciais não foram colocados em arquivos versionados.

## Permissões e revisões

Bubblewrap foi executado com um script de teste controlado: em somente leitura, escrita dentro e fora do projeto foi bloqueada; em workspace-write, escrita dentro do projeto passou e escrita fora foi bloqueada. Os arquivos temporários foram removidos. Kiro também executou os smokes reais dentro desse mecanismo. Isso comprova proteção de escrita nesse teste, sem afirmar isolamento de leitura de todo o host ou isolamento de rede. Codex usa o sandbox nativo configurado em cada turno. Aprovações tiveram validação de protocolo e regressões; não houve smoke real de alteração de arquivo autorizado pela tela.

Três codificadores GPT-6 Luna trabalharam em UI, backend e runtimes. GPT-6 Sol revisou os fluxos e corrigiu regressões. GPT-6 Astra revisou em uma execução independente do Codex CLI com sandbox somente leitura: o limite de threads impediu seu spawn pelo canal de colaboração. A revisão final não identificou P1 no escopo lido; encontrou o P2 de seleção corrigido e verificado por Sol e pelo orquestrador.

## Limites conhecidos

- Claude Code instalado, sem autenticação confirmada neste computador. Adaptador implementado e flags conferidas pelo CLI; execução completa e inferência com Claude Pro/Max ainda não validadas.
- OpenCode: instalação e modelos descobertos; execução não implementada e apresentada como indisponível.
- ai-jail ausente; integração futura. MCP funcional nesta versão: ai-memory. Não há catálogo geral, importação arbitrária de MCPs, isolamento de rede, Tailscale ou login por e-mail do aplicativo.
- Tokens e custos não informados pelo runtime permanecem indisponíveis. Modelos exibidos vêm da descoberta dos CLIs, não de uma lista simulada.

## Desktop Linux — 2026-10-04

Três codificadores Luna implementaram runtime, desktop e descoberta; o orquestrador integrou build/instalação e testes do pacote. Sol e Astra revisaram independentemente pelo Codex CLI em somente leitura. Os bloqueadores encontrados foram corrigidos e revalidados: dependências redundantes no asar, shutdown Graphify manual/compartilhado, processos de descoberta/status fora do cleanup, distinção ChatGPT/API key, startup antes do PID e preservação do cwd sob `/tmp` no bwrap. A revisão final do sandbox confirmou que o staging intermediário foi removido e os binds usam fontes reais do host.

- `npm run typecheck` e `npm run build` passaram. `npm test`: **88 testes em 11 arquivos**, todos passaram neste host, inclusive os três testes reais bwrap sem skip. `npm run package:linux` produziu `release/Adelic-0.1.0-linux-x86_64.AppImage` (117.369.439 bytes, cerca de 112 MiB) e SHA-256; checksum conferido.
- Host: Linux x86_64, Arch/Omarchy, sessão Wayland. Electron **44.5.1**, Node incorporado **24.21.0**, electron-builder **26.15.3**. SQLite incorporado executou consultas; o Node do desenvolvimento era 26.8.1, separado do pacote.
- Auditoria do `app.asar` final: **10 entradas**, contendo bundles, UI, metadados, ícone e avisos de licença; **zero node_modules**, arquivos de dados ou configurações de credenciais. O AppImage contém também o runtime Electron e seus recursos.
- `npm run desktop:smoke` passou no artefato final: execução a partir de pasta temporária, PATH inicial `/usr/bin:/bin` sem Node/npm neste host, criação de conversa avulsa, segunda abertura encaminhada sem novo backend, SIGTERM com backend encerrado, porta fechada, reabertura com DOM/API/SQLite válidos e conversa preservada. Resultado em `.desktop/validation/smoke.json`, sem conversas/credenciais.
- Abertura direta e alternativa de extração do AppImage passaram neste host. Instalador/reinstalação foram executados somente em prefixos XDG temporários com espaços e `%`; atalho/launcher foram conferidos e o aplicativo instalado passou no smoke. Antes da publicação, o instalador também passou sem o repositório, usando somente os três assets da release: checksum válido, binário idêntico, launcher executável e ícone genérico. Nenhuma instalação global foi necessária para esses testes.
- Inferência no pacote atualizado: **Codex GPT-6 Luna** respondeu `66` para 22 × 3, um worker, rota fast, ferramentas/memória desativadas, **3.552 ms** até conclusão; **Kiro GPT-5.6 Luna** respondeu `117` para 13 × 9, **2.262 ms**, usando conversa em `ADELIC_DATA_DIR=/tmp/...` após a correção bwrap. O histórico anterior da conversa permaneceu ao reabrir. A interface foi inspecionada no preview T3 conectado ao backend do AppImage.
- Fechamento durante uma execução Codex real: um processo Codex identificado antes de SIGTERM, execução persistida como **cancelled**, nenhum processo vivo remanescente na árvore da instância. Testes específicos também cobrem processos que ignoram SIGTERM e descoberta presa no initialize.
- O modo web anterior foi encerrado com **zero execuções ativas** antes da abertura desktop na base padrão, preservando o histórico existente. A janela desktop usa essa mesma base; testes anteriores em `/tmp` permanecem separados.

Esta evidência não comprova compatibilidade com outra distribuição. GTK/NSS/ALSA e demais bibliotecas gráficas do sistema continuam necessárias; CLIs/autenticação/bubblewrap/Graphify/ai-memory são externos ao pacote. Claude Pro/Max permanece sem inferência validada neste computador. A distribuição da v0.1.0 usa as releases do GitHub; atualização automática e acesso remoto não estão implementados. Veja [instruções do pacote](desktop-linux.md).
