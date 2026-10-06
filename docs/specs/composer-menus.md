# Menus do compositor e thinking por modelo

## Objetivo e referência

Pedido de 2026-10-05: substituir controles quadrados pela interação do T3 Code. Referência enviada: painel arredondado ancorado ao campo de mensagem, busca de modelos, navegação por provedor e controles compactos de modelo, thinking e permissões. Preservar a identidade escura do Adelic. Implementar pelo próprio Adelic após concluir a memória compartilhada.

## Menus

Trocar os selects de agente/modelo por um único seletor de modelo com popover: trilho de provedores, busca, modelo padrão e modelos realmente anunciados, indicador selecionado, favoritos locais opcionais. Não copiar logotipos nem inventar catálogo. Provedor indisponível é identificado claramente. Escolher modelo/provedor faz uma alteração atômica da sessão, mantendo draft. Controles de Thinking, modo, projeto e permissões também compactos/arredondados; organização e opções no rodapé, sem novas faixas superiores.

Popover ancorado no botão, aberto para cima quando necessário; usar portal ou mecanismo nativo que não seja recortado pelo compositor. Respeitar viewport em 360px e janelas baixas; lista rolável, envio sempre acessível, sem scroll horizontal. Busca recebe foco; Escape e clique externo fecham, foco volta ao acionador; setas/Enter ou navegação Tab permitem selecionar. Estado ativo e botões de provedor possuem nome acessível; desabilitar mudanças de sessão em execução. Manter Ajuda, vínculos, opções do projeto e cancelamento.

## Thinking

Catálogo real Codex 0.160 em 2026-10-05: Sol/Astra anunciam low, medium, high, xhigh, max, ultra; Luna anuncia até max. O protocolo aceita ReasoningEffort string não vazia. Usar os valores anunciados por modelo, sem enum limitado a três opções ou inferência pelo nome. Auto sempre disponível. Labels: none Sem raciocínio; minimal Mínimo; low Baixo; medium Médio; high Alto; xhigh Muito alto; max Máximo; ultra Ultra; valores novos anunciados permanecem selecionáveis com seu identificador. Sem esforços anunciados, oferecer apenas Auto e explicar o limite do catálogo.

Contrato ReasoningEffort permite identificador limitado; RoutePlan.effort pode estar ausente se runtime não informa níveis. Sessões existentes continuam legíveis. API valida formato e capacidade real antes de persistir um override; valores não anunciados são rejeitados, não enviados ao runtime. Trocar modelo/provedor ajusta escolha incompatível para Auto com aviso claro. Auto usa low/high conforme rota quando anunciado, defaultReasoningEffort declarado quando necessário ou outro valor válido; sem anúncio, omite parâmetro nativo. Adapter não deve passar undefined como argumento textual.

Override aplica-se ao coordenador e a cada tarefa quando suportado. Se um executor/revisor anuncia faixa diferente, escolher um nível compatível (mais próximo não superior quando possível), registrar o valor efetivo na tarefa/evento e não abortar o pipeline só por diferença de catálogo. Exemplo: coordenador Sol ultra, executor Luna max. Não carregar ferramentas/memória/grafo extra por aumentar thinking. Mensagens/atividade mostram nível efetivo sem chamar ultra de baixo.

Fonte: [Codex App Server — Models](https://learn.chatgpt.com/docs/app-server#models), verificada com catálogo e schemas do executável instalado. Catálogo não comprova direito de uso; inferência real verifica apenas a solicitação executada.

## Validação

Testar esforços extras, padrão/ausência/vazio/capabilityfalse, troca incompatível, persistência, fase delegada com catálogo diferente e argumentos nativos. No preview T3: buscar/trocar modelo, provider rail, pensar max/ultra conforme modelo, Escape/Tab/cliqueexterno, draft preservado, popover em viewport baixo/estreito, envio e scroll. Não publicar sem checks, revisão independente e pacote Linux instalado com dados preservados.
