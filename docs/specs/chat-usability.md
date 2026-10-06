# Uso do chat e controle de thinking

2026-10-05 — Polimento solicitado após o uso do desktop v0.1.0. A resposta e a conversa devem permanecer em primeiro plano; tarefas e comandos continuam disponíveis para inspeção, sem ocupar toda a tela automaticamente.

## Atividade do turno

- Vincular tarefas e eventos ao respectivo `runId` no histórico, junto ao pedido e à resposta. Não renderizar as tarefas do último turno acima de toda a conversa.
- Mostrar uma linha compacta de atividade, recolhida por padrão. Indicar trabalho em andamento e falha/cancelamento sem despejar comandos ou saídas.
- Ao expandir, apresentar tarefas e ações com título, papel, provedor/modelo e estado. Resultados extensos e planos JSON só aparecem após uma ação de inspeção; saídas completas continuam carregadas sob demanda.
- Agrupar início/fim de uma mesma ação quando houver identificação suficiente; preservar ações distintas e respectivos dados. O comando integral permanece acessível em detalhes, sem truncamento destrutivo.
- Preservar título e tipo quando o runtime enviar somente uma atualização de estado por ID. Não confundir duas execuções diferentes do mesmo comando.
- Aprovações pendentes e erros devem permanecer visíveis mesmo com atividade recolhida. Conservar cancelamento, reconexão SSE e histórico de turnos anteriores.
- Incluir os metadados de tarefas de todos os turnos carregados, sem limitar a lista aos 30 mais recentes. Retirar saídas completas antes de consultar o snapshot e validar a propriedade da tarefa ao carregá-la.
- Tabelas e blocos de código têm largura útil e rolagem quando necessário, evitando quebrar nomes de arquivos em cada letra.

## Thinking

- Seletor por conversa: Automático, Baixo (`low`), Médio (`medium`) e Alto (`high`). Persistir como `Session.thinking`; ausência em conversas antigas equivale a Automático.
- Modo Auto/Rápido/Completo continua responsável por ferramentas, memória e orçamento de contexto. Thinking controla esforço do modelo sem promover uma pergunta simples para um pipeline maior.
- Automático preserva a escolha anterior de esforço por fase; escolha explícita chega ao executor direto e às fases de planejamento, execução, revisão e síntese.
- Respeitar capacidade do provedor e esforços anunciados pelo modelo. Rejeitar seleção explicitamente incompatível com mensagem compreensível; não substituir silenciosamente um esforço selecionado.
- Troca de provedor/modelo pode restaurar Automático quando o nível anterior deixa de ser válido. Alterações ficam bloqueadas durante execução; respostas atrasadas não podem alterar a seleção de outra conversa.
- Codex usa esforço no protocolo app-server; Kiro e Claude Code usam as opções de suas CLIs. Não confundir capacidade de configuração com autenticação ou inferência efetivamente validada.

Referências: [Codex app-server](https://learn.chatgpt.com/docs/app-server) e [reasoning effort](https://developers.openai.com/api/docs/guides/reasoning). O catálogo e o protocolo das CLIs instaladas precisam ser conferidos para cada integração.

## Aceite

Typecheck, testes e build aprovados; validação da API de thinking, persistência e propagação nas chamadas delegadas. Conferir no preview T3 uma conversa existente com várias tarefas/comandos e outra com resposta rápida, disclosure de saída completa, mudança de thinking e layout estreito. Gerar um pacote local atualizado e reinstalar preservando o histórico; não substituir os assets já publicados da v0.1.0.
