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
| Sobrecarga (`overloaded`) | "at capacity", "overloaded", "high load", 503, 529, "server is busy", "try again later" | sim, com espera 3× maior |
| Limite de requisições (`rate_limit`) | 429, "rate limit", "too many requests", "throttled", cota por minuto, `RESOURCE_EXHAUSTED` | sim, com espera 3× maior |
| Permanente | autenticação, cota, contexto grande demais, configuração bloqueada, pedido inválido, cancelamento, erro desconhecido | não |

Padrões permanentes têm prioridade: "authentication timed out" é tratado como autenticação, não como timeout. Cota de cobrança ("insufficient_quota", "billing") continua permanente; só cotas por janela de tempo contam como limite de requisições. Entre os dois tipos de capacidade, limite de requisições vem primeiro ("429 … try again later" é limite, não sobrecarga). Execuções antigas gravadas como `capacity` são tratadas como os dois tipos novos. Erros desconhecidos são tratados como permanentes. Na dúvida, o Adelic não repete sozinho.

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
- Sem a troca automática ligada, o Adelic espera e repete o mesmo modelo; veja **Troca de modelo**.

## Troca de modelo

Quando a execução termina com sobrecarga ou limite de requisições, trocar de modelo costuma resolver mais rápido do que esperar.

### Manual: "Tentar com outro modelo"

- Abaixo da resposta que falhou por sobrecarga ou limite, ao lado de **Tentar de novo**, aparece **Tentar com outro modelo** com até 3 opções: primeiro os outros modelos do mesmo provedor (sem o que falhou), depois o modelo padrão de cada outro provedor disponível. Se a troca automática já tentou modelos nessa execução, eles não são oferecidos de novo.
- A escolha chama `POST /api/runs/:id/retry` com `{ providerId?, model? }`. O mesmo endpoint, sem corpo, repete com o modelo atual. Ele, de uma vez só:
  - valida que o provedor está disponível e que o modelo está no catálogo dele (400 caso contrário) e recusa com 409 enquanto houver execução ativa na conversa;
  - troca o provedor ou o modelo **da conversa**, como o seletor de modelo (`PATCH /api/sessions/:id`): remove `nativeSessionId`, e o Thinking volta para Automático se o novo modelo não o oferece;
  - reenvia o mesmo pedido, com os mesmos anexos, como uma nova execução. Se ela não puder começar, a conversa volta ao modelo anterior.
- Como a sessão nativa foi descartada, o novo agente começa uma sessão nova e recebe as mensagens recentes da conversa no prompt (`boundedPrompt`, o mesmo caminho de qualquer troca de provedor). Tarefas de um plano são repetidas pelo cartão do plano, não por aqui.

### Automática (opcional)

- **Configurações › Agentes e respostas › Trocar de modelo se o atual estiver sobrecarregado**, desligada por padrão. Ligada, escolhe-se até 3 modelos do catálogo, em ordem (`Settings.modelFallback: { enabled, models: [{ providerId, model }] }`).
- Só entra em ação quando a falha é de sobrecarga ou limite, **as novas tentativas automáticas se esgotaram** e a regra de segurança vale: a tentativa não exibiu texto, não executou ferramenta e não pediu aprovação. Com "Repetir falhas temporárias" desligado, a troca acontece já depois da primeira tentativa.
- Cada modelo da lista é tentado **uma vez**, em ordem, com a mesma regra. Modelos de provedores indisponíveis, fora do catálogo, iguais a um já tentado ou incapazes de atender ao pedido (ferramentas, caminho rápido, imagens) são pulados. Para na primeira resposta bem-sucedida, numa falha de outro tipo ou numa tentativa que já produziu efeito.
- A troca vale **só para essa execução**: o modelo da conversa não muda e a sessão nativa da conversa é preservada. Toda tentativa de troca (de provedor ou só de modelo) roda sem `nativeSessionId`, com o histórico no prompt, e a sessão nativa que ela abrir não substitui a da conversa. Sandbox e aprovação são os mesmos da execução.
- A execução guarda `run.fallback: { from, to, reason }`, a atividade mostra "modelo trocado" e a linha "Modelo sobrecarregado: trocado de Codex · X para Codex · Y" (ou "Limite de requisições: …"), com o erro original no tooltip. A resposta mostra o nome do provedor que de fato respondeu.
- **Execuções coordenadas:** vale para cada chamada delegada que falhar (planejador, executor, revisor, síntese), com o título da tarefa na linha da atividade; a tarefa passa a registrar o modelo usado. `run.fallback` guarda a primeira origem e o último destino.

## Validação

- **Unitários:**
  - mais de 30 mensagens reais e típicas classificadas, incluindo as já vistas na base do Adelic: "Selected model is at capacity", "Provider process exited (0)" e o timeout do Kiro;
  - cálculo da espera;
  - nada é repetido depois de texto, ferramenta ou aprovação;
  - cancelamento durante a espera.
- **Orquestrador:** timeout direto repetido e recuperado; falha depois de texto sem repetição; permanente; configuração desligada; planejador repetido em execução coordenada.
- **E2E:** timeout recuperado com o registro na tela; falha parcial com **Tentar de novo** reenviando o pedido.
- **Troca de modelo** (`tests/model-fallback.test.ts`, `tests/e2e/model-fallback.spec.ts`): alternativas oferecidas; esquema das configurações; endpoint com validação, 409 e troca de provedor sem `nativeSessionId` e com histórico; troca automática só depois das novas tentativas, só sem efeito, uma vez por modelo, com `run.fallback` e sem mudar o modelo da conversa, inclusive numa tarefa delegada; na tela, "Tentar com outro modelo", a troca automática e a lista em Configurações a 360 px.
- **Real:** Kiro 2.23 e Codex 0.160 sem falha continuam iguais, sem nenhuma repetição. Não foi possível provocar um timeout real sob demanda.
