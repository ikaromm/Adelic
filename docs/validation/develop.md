# Validação depois da v0.4.0 (develop) — 2026-10-06

## Verificado

- **CI** (GitHub Actions, cada push para `develop`):
  - typecheck, lint, formatação;
  - cobertura com piso: `server/` com 80% das linhas e 65% dos branches, `shared/` com 90% das linhas;
  - 245 testes unitários e de integração e 19 fluxos E2E;
  - testes de integração contra ai-memory **2.1.0 e 2.5.2** reais;
  - geração do AppImage e smoke gráfico headless em **Ubuntu 24.04, Ubuntu 22.04, Debian 12 e Fedora 42**, além do Arch/Omarchy local.
- **Codex 0.160 real:** passou pelo novo parser de protocolo. Um comando com aprovação automática gerou os eventos de ferramenta e a resposta. `thread/tokenUsage/updated` virou uso de tokens (4.605 de entrada e 5 de saída numa resposta curta). O Codex não informa custo.
- **Kiro 2.23 real:** respondeu 56 para 7 × 8 pelo envelope validado.
- **Busca nas conversas** (migração 2), numa cópia da base real:
  - migração 1 → 2 com backup e tabelas idênticas;
  - 130 de 130 mensagens indexadas;
  - busca em 6 ms.
- **Acesso remoto:**
  - testado em `127.0.0.2`, sem exposição na rede: token obrigatório, cookie `HttpOnly` e `SameSite=Strict`, bloqueio de origem cruzada e limite de tentativas;
  - fluxo de login no navegador conferido por um relay.
- **ai-memory nativo deste computador**, somente leitura: catálogo, busca e leitura iguais pelo novo parser.

- **Repetição automática:** classificador, política, orquestrador (execução direta e tarefa delegada) e E2E cobertos; Kiro e Codex reais sem falha não fazem nenhuma repetição. Um timeout real não pôde ser provocado sob demanda. Detalhes em [repetição automática](../specs/retries.md).

## Não verificado

- Claude Code e OpenCode: não estão instalados.
- Acesso remoto por uma interface Tailscale real: o teste usa outro endereço de loopback.
- Leitor de tela e zoom de 200%.
- Docker local: o usuário não tem acesso ao `docker.sock`. As distribuições foram testadas só na CI.
