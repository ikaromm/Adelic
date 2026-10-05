# Tarefas de implementação e validação

Autorização de delegação: o usuário pediu codificadores GPT-6 Luna em paralelo e revisores Sol/Astra. O agente principal coordena contratos, integração, documentação e testes reais.

- [x] Recuperar contexto pertinente e inspecionar repositório.
- [x] Escrever requisitos, design e contrato compartilhado.
- [x] Luna UI: implementar src/ com chat, projetos, memória, atividade e configurações.
- [x] Luna backend: persistência, API, roteamento adaptativo, orquestração, memória e testes relevantes.
- [x] Luna runtimes: implementações ProviderRegistry e adaptadores, validação de protocolos e lifecycle.
- [x] Integrar os módulos, instalar dependências e corrigir typecheck/build.
- [x] Sol: revisar estado/concorrência, API, cancelamento, reconexão, erros e comportamento de UI.
- [x] Astra: revisar limites de execução, credenciais, qualidade do roteamento e defeitos de arquitetura.
- [x] Executar testes de regressão e smoke com provedor real.
- [x] Verificar UI no preview T3 em desktop/mobile e corrigir defeitos observados.
- [x] Atualizar README, memória do projeto e evidências; deixar servidor local aberto.

Evidências em `docs/validation.md`. Claude requer login e validação real posterior; OpenCode oferece somente descoberta neste incremento. Acesso remoto/Tailscale, integração ai-jail e um catálogo geral de MCPs são incrementos futuros.

## Orquestração e Graphify por projeto

- [x] Configuração padrão, executor/revisor, tarefas e brief persistidos por projeto.
- [x] Uma chamada para perguntas simples e para perguntas que precisam apenas de memória.
- [x] Plano estruturado, dependências, leitura concorrente, escrita serial, revisão e síntese.
- [x] Graphify AST local, índice fora do repo, consultas limitadas e detecção de índice desatualizado.
- [x] Tela com configurações, consulta do grafo, tarefas reais e saída completa sob demanda.
- [x] Memória/skills seletivas preservadas, falhas explícitas, cancelamento/aprovações e exportação.
- [x] Revisões Sol/Astra, correções de integração e 50 regressões aprovadas.
- [x] Smokes Codex/Kiro, pipeline com cinco papéis, leitura por caminho, preview desktop/mobile e servidor local ativo.

## Conversas avulsas e tema escuro

- [x] Spec, contratos nullable e migração preservando histórico.
- [x] Backend: criação avulsa, vínculo/desvínculo atômicos e workspace próprio com delegação.
- [x] UI: botão global, atalhos, + por projeto, seletor de vínculo e saída histórica sob demanda.
- [x] Tema escuro, contraste dos controles e toolbar responsiva em grade.
- [x] Revisões Sol/Astra e correção de snapshots anteriores a mutações aceitas.
- [x] 60 regressões, typecheck/build e verificação da migração no banco real.
- [x] Codex criou dois programas e um script avulso; executores, revisão e testes reais passaram.
- [x] Preview desktop/mobile, vínculo/desvínculo e corrida com health atrasado conferidos.

## Desktop Linux

- [x] Spec com contratos de runtime, janela, descoberta, build e verificação.
- [x] Electron com Node/SQLite incorporados, backend utilitário em loopback e porta livre.
- [x] Caminhos absolutos, histórico compartilhado com modo web, bloqueio da base e segunda instância.
- [x] Descoberta portável das CLIs e overrides estritos; autenticação ChatGPT/API key diferenciada.
- [x] Encerramento de execuções, descoberta, comandos de status e Graphify, inclusive espera compartilhada.
- [x] Sandbox preserva workspaces temporários, aliases e permissões com bwrap real.
- [x] AppImage Linux x86_64 e SHA-256, whitelist sem node_modules/dados/credenciais.
- [x] Instalador opcional com comando e menu; testes em prefixos XDG temporários com espaços.
- [x] Revisões Sol/Astra, typecheck/build, 88 testes e smoke do pacote fora do repositório sem Node/npm no PATH inicial.
- [x] Inferência real Codex/Kiro, cancelamento ao encerrar e preservação de histórico ao reabrir.
- [ ] Validar o pacote em outras distribuições Linux além de Arch/Omarchy.
