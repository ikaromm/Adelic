# Ferramentas locais no caminho rápido

2026-10-05 — Decisão do usuário: manter ferramentas do computador disponíveis também para perguntas rápidas. O executor decide quando consultá-las; não depender de uma lista de palavras sobre dispositivos para conseguir investigar uma situação local.

## Contrato

- `RoutePlan.level` escolhe contexto e estratégia de execução. `tools` informa disponibilidade, não uso efetivo. Rotas rápidas Auto e Rápido explícito têm `tools: true`; ações realizadas são registradas em eventos separados.
- A rota rápida mantém um executor e esforço baixo por padrão, respeitando o thinking manual. Não consulta memória, Graphify, catálogo geral de MCPs ou toda a biblioteca de skills; não chama planejador, revisor ou síntese.
- Perguntas conceituais podem ser respondidas diretamente. Pedidos que dependem do estado do computador permitem consultas locais, mesmo se o classificador não reconhecer o assunto.
- Provedores devem honrar `plan.tools` independentemente de `level`. Chamadas internas com `tools: false` continuam sem ferramentas. Não elevar sandbox, escrita ou aprovações devido à mudança de rota.
- Provedor sem capacidade anunciada não pode ser apresentado como capaz de executar ferramentas locais.

## Integração

Codex mantém processos distintos por diretório e perfil: sem ferramentas, rápido com ferramentas locais e completo. O perfil rápido disponibiliza shell/unified exec e mantém o host necessário para executá-los (`code_mode_host` no CLI 0.160.0); desativa busca web, browser, recursos extras, MCPs configurados, hooks e descoberta automática de skills/documentos. As restrições são aplicadas no processo e na configuração da thread, evitando herdar políticas de outro perfil.

Kiro mantém perfil temporário com ferramentas explícitas e bubblewrap; Claude utiliza a lista de ferramentas que sua integração consegue oferecer segundo a política configurada. Isso não comprova acesso irrestrito a dispositivos, rede ou interface gráfica, nem autenticação de um runtime indisponível.

## Aceite

1. Uma pergunta simples termina com um executor, ferramentas disponíveis e nenhum comando desnecessário, sem memória/grafo/planejamento.
2. Um pedido de diagnóstico local usa comandos reais na rota rápida; eventos/saídas e limitações ficam visíveis.
3. Rápido explícito consegue ler um arquivo de teste e retornar seu conteúdo verificado.
4. Thinking, cancelamento e aprovações continuam válidos; perfis rápidos/completos/internos não compartilham configurações incompatíveis.
5. Typecheck, testes, build e smoke do AppImage passam; atualizar instalação local preservando histórico. Não publicar nem substituir releases anteriores. A disponibilidade não garante que todo modelo escolherá executar uma consulta em um pedido ambíguo; validar comandos efetivos pelos eventos, não pela intenção escrita na resposta.
