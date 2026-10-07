# Continuar com outro agente

2026-10-07. Pedido: trocar o agente de uma conversa levando, se o usuário quiser, um resumo do que já foi feito.

## Onde aparece

- **Continuar com outro agente** (ícone de setas no topo da conversa): escolhe agente e modelo.
- **Menu de modelo**: escolher um agente **diferente** numa conversa que já tem mensagens pergunta "Levar um resumo da conversa?". Trocar só o modelo, ou trocar o agente numa conversa vazia, continua como antes (`PATCH`).

Opções:

- **Com resumo** (padrão): o agente atual escreve o resumo.
- **Só o histórico recente**: troca sem nenhuma chamada de modelo.
- **Cancelar**: nada muda. Durante o resumo, Cancelar interrompe a chamada e a conversa fica no agente atual.

## Resumo

Uma única chamada ao agente **atual**, com o mesmo modelo: sandbox `read-only`, sem ferramentas, sem memória, rota rápida quando o agente a oferece, aprovação manual (qualquer pedido de aprovação é negado na hora) e limite de 2 minutos. O prompt (`server/provider-handoff.ts`) pede em português, com até 1.500 caracteres: **Objetivo**, **Estado atual**, **Decisões**, **Arquivos e comandos relevantes**, **Pendências** e **Próximo passo**. A transcrição enviada é limitada a 16.000 caracteres, cada mensagem a 2.000, das mais recentes para as mais antigas, e começa no último resumo de passagem quando houver.

Se o agente atual estiver indisponível, a chamada falhar, esgotar o tempo ou voltar vazia, o Adelic monta um **resumo local** a partir das últimas mensagens (objetivo, última resposta, últimas mensagens, arquivos e comandos citados, próximo passo), sem chamar modelo, e avisa o motivo no cartão e num aviso da tela. Uma conversa sem mensagens troca sem resumo.

## Troca

A conversa passa para o novo agente e modelo, `thinking` volta a Automático e `nativeSessionId` é apagado. O resumo fica guardado como mensagem `role: 'system'` com `handoff` (agentes, modelos, origem `model` ou `local` e o motivo do resumo local). Foi a opção menos invasiva: o papel `system` já existia no contrato e na busca, e nenhuma migração é necessária.

O cartão "Passagem para Kiro" mostra o ícone, "Resumo levado para Kiro · Resumo escrito por Codex" (ou o motivo do resumo local, em laranja) e abre ao clicar.

## Histórico depois da troca

Cada execução recebe o **último resumo de passagem e só as mensagens depois dele** (`handoffHistory`). O resumo vai como mensagem do agente, rotulada como dado e não como instrução, e ocupa até 60% do orçamento de contexto da rota (no mínimo 600 caracteres); as mensagens seguintes dividem o resto (`boundedHistory`). Sem resumo ("Só o histórico recente"), nada muda: as mensagens recentes seguem pelo orçamento de sempre.

Verificação: o Adelic já enviava o histórico recente em toda execução; nenhum adaptador retoma a sessão nativa (Codex abre um thread efêmero, Kiro um `session/new`), então "Só o histórico recente" já funcionava. A lacuna era o caminho com resumo: antes, o histórico inteiro anterior continuaria indo junto.

## API

`POST /api/sessions/:id/handoff` `{ providerId, model?, summary: 'model' | 'local' | 'none' }` → `202 { session, message? }`.

- 400: provedor desconhecido, igual ao atual ou indisponível, modelo fora do catálogo, corpo inválido.
- 404: conversa não encontrada.
- 409: execução ativa, plano em execução, outra passagem em andamento ou passagem cancelada.

Enquanto o resumo é escrito, a conversa fica reservada como uma execução: mensagens, `PATCH` e outra passagem respondem 409, e mensagens na fila começam depois, já no novo agente.

## Validação

- Unitários (`tests/provider-handoff.test.ts`): limites do prompt, resumo pelo modelo (somente leitura, sem ferramentas), resumo local em falha, resposta vazia, indisponibilidade e tempo esgotado, aprovação negada, `nativeSessionId` apagado, próxima execução com o resumo e só as mensagens seguintes, `none` com histórico recente, validação, 409 e cancelamento.
- E2E (`tests/e2e/provider-handoff.spec.ts`) com um segundo provedor simulado, "Kiro (E2E)": troca pelo menu com resumo, troca pelo topo só com histórico, resumo local depois de falha, Cancelar e tela de 360 px.
- Não testado com agentes reais.
