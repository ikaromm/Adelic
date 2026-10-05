# Changelog

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
