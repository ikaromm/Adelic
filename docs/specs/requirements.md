# Requisitos do aplicativo web local Adelic

O usuário autorizou em 04/10/2026 a implementação de uma aplicação própria, inicialmente acessível apenas no computador local. A primeira versão deve oferecer conversa funcional com os agentes instalados, histórico, projetos, controles de execução e contexto compartilhado. O requisito central de desempenho é adequar o trabalho à pergunta: perguntas simples não devem iniciar pesquisa, consulta de memória, planejamento extenso ou delegação desnecessária.

## Experiência e funcionalidades

- Interface web em português, responsiva, clara, com identidade própria. Sidebar para projetos e conversas, área central de chat, seletor de agente/modelo e compositor com Auto, Rápido e Completo.
- Perguntas diretas usam baixa intensidade, contexto limitado e ferramentas desabilitadas quando o protocolo permite. Solicitações com pesquisa, arquivos, desenvolvimento ou contexto anterior habilitam o caminho completo. Classificação local, sem chamada adicional de LLM. O operador pode forçar um modo.
- Mostrar o modo efetivamente usado e uma justificativa curta. Medir tempo até primeiro texto e duração total. Não prometer latências fixas independentes do provedor.
- Executar Codex, Claude Code e Kiro pelos runtimes existentes. OpenCode é integração adicional útil ao Kiro já instalado. Mostrar instalação/disponibilidade real e erros de autenticação. Não criar resposta fictícia para ocultar ausência de provedor.
- Chat com streaming e Markdown, mensagens persistidas, erros visíveis, cancelamento e retomada por novo turno. Fechar o navegador não deve cancelar o processo. Reiniciar o servidor marca trabalhos pendentes como interrompidos.
- Cadastro de projeto por caminho existente no host. Persistência de configurações, projetos, conversas, mensagens, eventos e métricas fora de arquivos versionados.
- Aprovações de ferramentas via interface quando suportadas. Modo padrão de leitura; permissão de escrita é uma escolha explícita. Nunca anunciar isolamento onde o runtime não o oferece.
- Tela de memória que pesquisa e lê páginas do ai-memory por escopo explícito. Escrita de notas apenas por ação do operador. Não enviar notas privadas a arquivos versionados.
- Configurações com provedor, modo, memória, escopo do projeto e permissão de execução. Catálogo de skills com procedimentos úteis; ações executáveis precisam de wiring real, ausência deve ser visível.
- Tela de atividade/uso com métricas reais de execuções. Custo ausente é mostrado como indisponível, não como zero.
- Exibição das integrações e disponibilidade do ai-memory/ai-jail. ai-jail deve ser detectado e sua ativação depende de integração verificada; a presença do binário não comprova execução isolada.

## Escopo e limites desta entrega

Interface e servidor locais; bind em 127.0.0.1, porta padrão 4317. Sem login público, Tailscale, relay, instalação de serviços globais ou alterações de credenciais. Esta versão deve ser iniciável com npm e deixada aberta para o usuário testar. A integração T3 serve como referência de experiência, sem editar a instalação T3 existente.

A etapa inicial não incluía commits ou publicação. Após a entrega e validação do desktop Linux, o usuário autorizou em 04/10/2026 publicar a v0.1.0 com documentação, branches `master`/`develop` e release no GitHub. O aplicativo continua acessível somente no computador local.

## Critérios de aceite

1. npm install, npm run typecheck, npm test e npm run build funcionam.
2. A aplicação abre no preview compartilhado e permite criar projeto/conversa e enviar mensagem a pelo menos um provedor real disponível.
3. Uma pergunta direta percorre a rota rápida sem consulta de memória ou inicialização de ferramentas adicionais. Uma solicitação complexa ou modo manual percorre a rota completa.
4. Histórico sobrevive a recarregar a página e reiniciar o backend. A reconexão não duplica mensagens.
5. Cancelar encerra o turno/processo e permite continuar. Dois envios simultâneos na mesma conversa não criam execuções concorrentes.
6. Erros de autenticação, provedor indisponível e memória offline são claros e não apagam conteúdo.
7. Não há métricas, modelos disponíveis, tarefas concluídas ou proteções simuladas apresentados como reais.
8. Revisões independentes em modelos Sol e Astra cobrem correção, isolamento e fluxo do usuário. Achados impeditivos são corrigidos antes da entrega.
