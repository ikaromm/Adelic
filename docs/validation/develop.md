# Validação depois da v0.4.0 (develop) — 2026-10-08

Estado do `develop` com os 21 recursos do roadmap inspirado em outras harness (anexos, fila, notificações, checkpoints, menções, comandos salvos, modo plano, troca de modelo, editar/ramificar, compactação, outro agente, paleta, worktree, painel Git, verificações e bloqueios, MCP, terminal/preview, automações, limites de uso, voz e PWA). Cada recurso tem a sua especificação em `docs/specs/`, com o que foi verificado e o que não foi.

## Verificado

- **Suíte local no tree integrado:**
  - typecheck, lint (0 erros) e formatação;
  - 733 testes unitários e de integração com cobertura acima do piso (`server/` 80% das linhas e 65% dos branches, `shared/` 90%);
  - build;
  - 89 fluxos E2E (Playwright, provedor simulado).
- **Sandbox real (bubblewrap)** nos testes de:
  - terminal;
  - verificações por projeto;
  - leitura de anexos;
  - binários de MCP.
  
  Cobrem escrita fora do projeto recusada, sem rede nas verificações e parada de toda a árvore de processos.
- **Git real** em repositórios temporários (checkpoints, painel Git, worktrees):
  - HEAD, índice, stash e branches do usuário intactos;
  - hooks, filtros, `textconv`, merge drivers e hooks definidos por config nunca executam por padrão;
  - push nunca força.
- **Codex 0.160 real**, sem chamar o modelo:
  - `localImage` aceito no `turn/start`;
  - `turn/steer` existe no protocolo;
  - `thread/start` aceita `config.mcp_servers` só para aquela thread.
- **Kiro 2.23 real**, sem chamar o modelo:
  - `initialize` anuncia imagens;
  - `session/new` aceita `mcpServers`;
  - a lista de servidores da sessão pode ser consultada.
- **Turnos com modelo real** (2026-10-07, pelos adaptadores do Adelic, sandbox somente leitura):
  - imagem PNG vermelha anexada: Codex 0.160 e Kiro 2.23 responderam "Vermelho";
  - orientação (`turn/steer`) no Codex durante uma contagem: aceita no turno em andamento, que terminou respondendo a palavra pedida na orientação.
- **voxtype 1.1.0 local** (whisper, modo local, large-v3): a transcrição de um tom gerado passou pelo pipeline real com ffmpeg. O teste fica desligado por padrão (`ADELIC_VOICE_INTEGRATION=1`).
- **Electron** com uma pasta de dados descartável: permissão de notificação concedida só à própria origem; câmera continua negada.

## Não verificado

- **Turnos com modelo real:**
  - chamada de ferramenta MCP com aprovação;
  - sobrecarga real para a troca de modelo.
- **Voz:** microfone de verdade no navegador ou no Electron, e fala real transcrita.
- **PWA:** num celular por `tailscale serve`.
- **Pacote Electron:** política de navegação do preview e abertura do link de PR.
- **Ambiente:**
  - Claude Code e OpenCode não estão instalados;
  - Docker local não está disponível; as distribuições são testadas na CI.
- **Acessibilidade:** leitor de tela e zoom de 200%.

## Testes instáveis observados

`plan-mode.spec.ts` (estado "Em execução" curto) e `checkpoints.test.ts` ("records an empty list…") falharam uma vez cada sob carga e passaram ao repetir. O teste de cancelamento das verificações falhava porque `--new-session` tirava a árvore do sandbox do grupo de processos. Isso foi corrigido com `--info-fd`, como no terminal.
