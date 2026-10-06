# Repetição automática de falhas

2026-10-06. Pedido: quando o modelo ou o agente falha por timeout ou erro passageiro, como em `{"message":"Kiro stream failed: The operation timed out.","type":"kiro_error"}`, a execução não deve morrer sem uma nova tentativa inteligente.

## Regra central

Uma falha só é repetida automaticamente quando a repetição é **segura**. Isso exige que a tentativa que falhou não tenha produzido nenhum efeito visível:

- nenhum texto exibido;
- nenhuma ferramenta iniciada (comando, edição de arquivo, MCP);
- nenhuma aprovação pedida.

Depois que qualquer uma dessas coisas acontece, repetir poderia executar um comando duas vezes ou duplicar uma resposta. Nesse caso a execução termina como falha, e a tela oferece **Tentar de novo**, que é uma decisão do usuário.

## Classificação (`server/retry.ts`)

| Tipo | Exemplos | Repete automaticamente? |
|---|---|---|
| Transitória | tempo esgotado, `stream failed`, conexão interrompida, 5xx, processo do agente encerrado | sim, se não houve efeito |
| Capacidade | modelo sobrecarregado ("at capacity"), 429, limite de requisições | sim, com espera 3× maior |
| Permanente | autenticação, cota, contexto grande demais, configuração bloqueada, pedido inválido, cancelamento, erro desconhecido | não |

Padrões permanentes têm prioridade: "authentication timed out" é tratado como autenticação, não como timeout. Erros desconhecidos são tratados como permanentes. Na dúvida, o Adelic não repete sozinho.

## Política

- Até **2 novas tentativas** (3 no total), com espera exponencial de 2 s, 4 s e assim por diante, até 30 s, com jitter de ±25%.
- Cancelar durante a espera interrompe imediatamente.
- Vale para a execução direta e para cada tarefa delegada (planejador, executor, revisor, síntese). Uma tarefa repetida recomeça do estado anterior à tentativa que falhou.
- Configurável em **Configurações › Agentes e respostas › Repetir falhas temporárias**. Vem ligado; desligado, nada é repetido, mas a tela continua explicando a falha e oferecendo o botão.

## O que aparece na tela

- **Durante a espera:** a linha da atividade mostra "tentativa 2/3". O painel mostra o evento "tempo esgotado; tentando de novo (2/3) em 2 s", com o erro original no tooltip.
- **Ao final:** "1 nova tentativa" na linha da atividade. A execução guarda `run.retries`.
- **Em caso de falha:** abaixo da resposta aparece o motivo, as tentativas feitas e, quando for o caso, por que não houve repetição automática (por exemplo "texto já exibido"). Falhas permanentes mostram "Repetir provavelmente não resolve". **Tentar de novo** reenvia a mesma mensagem como uma nova execução e só aparece na última resposta.

## Limites

- A classificação é por texto da mensagem de erro, porque os CLIs não padronizam códigos. Mensagens novas caem como "erro não reconhecido", portanto sem repetição, até serem adicionadas aos padrões com um teste.
- Uma falha no meio de uma resposta longa não é retomada: o reenvio recomeça a resposta.
- O Adelic não troca de modelo sozinho em caso de capacidade; ele espera e repete o mesmo.

## Validação

- **Unitários:**
  - 18 mensagens reais e típicas classificadas, incluindo as já vistas na base do Adelic: "Selected model is at capacity", "Provider process exited (0)" e o timeout do Kiro;
  - cálculo da espera;
  - nada é repetido depois de texto, ferramenta ou aprovação;
  - cancelamento durante a espera.
- **Orquestrador:** timeout direto repetido e recuperado; falha depois de texto sem repetição; permanente; configuração desligada; planejador repetido em execução coordenada.
- **E2E:** timeout recuperado com o registro na tela; falha parcial com **Tentar de novo** reenviando o pedido.
- **Real:** Kiro 2.23 e Codex 0.160 sem falha continuam iguais, sem nenhuma repetição. Não foi possível provocar um timeout real sob demanda.
