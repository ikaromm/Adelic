# Chat com controles no rodapé

2026-10-05 — Pedido do usuário: validar projetos pequenos e mini fixes usando o próprio Adelic, começando por uma UI menos poluída e controles do chat movidos do topo para a parte inferior.

## Mudança

- Manter o cabeçalho de navegação com título/projeto, badge local e ajuda. Remover do topo do chat a toolbar de seletores, faixa de coordenador e aviso persistente de vínculo.
- Levar agente, modelo e thinking para uma linha compacta junto ao campo de mensagem, usando `composer-controls`. Enviar/cancelar fica sempre acessível, fora de disclosures, preservando o comportamento de Enter/Shift+Enter.
- Usar `composer-options` (details/summary recolhido por padrão) para projeto da conversa, modo Auto/Rápido/Completo e informação/configuração da orquestração. O summary indica projeto atual e modo, permitindo descobrir onde anexar um projeto.
- Preservar todos os labels acessíveis, opções de thinking anunciadas, persistência, bloqueios durante execução, cancelamento, mensagens, aprovações e atividade por turno. Não alterar backend, contratos ou regras de delegação neste mini fix.
- Tema escuro e contraste legível. Evitar repetir caminho, coordenador, modo e instruções em várias faixas. Rodapé se adapta à largura disponível com sidebar aberta/recolhida e permite usar todos os controles em 360 px.
- Componentes e estilos devem concordar nas classes `composer-controls`, `composer-options`, `composer-options-content`, `composer-context`. Remover regras obsoletas/conflictantes das faixas retiradas; evitar uma cadeia de overrides.

## Execução pelo Adelic

Usar o aplicativo instalado, projeto Adelic real e nova conversa identificada. Sol coordena; Luna implementa em dois escopos: `src/App.tsx` e `src/styles.css`, sem sobreposição. Astra faz a revisão do pipeline; Sol faz revisão adicional quando necessário. Dados operacionais e evidências brutas ficam fora do Git. Preservar alterações pré-existentes; não fazer commit, push, release pública, alterações de credenciais ou configuração global.

## Aceite

1. Chat existente sem faixas de configuração no topo; agente/modelo/thinking aparecem junto ao composer.
2. Opções recolhidas permitem anexar/desanexar projeto e escolher modo, preservando histórico.
3. Enviar/cancelar e aprovações funcionam, seletores ficam bloqueados durante execução.
4. Verificar no preview T3 o fluxo real e layouts de 360 px a desktop, incluindo sidebar recolhida e viewport baixa.
5. Typecheck, testes, build e smoke Linux passam. Gerar e instalar incremento local preservando histórico; registrar bugs encontrados pelo uso do Adelic e separar confirmação real de testes simulados.
