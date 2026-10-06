# Changelog

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
