# Entrega e validação do loop de usabilidade — 2026-10-09

## Escopo e estado

Este registro é um snapshot **ANTES DA PUBLICAÇÃO** da entrega de usabilidade/harness no pacote **0.5.3**, na branch **develop**, e da validação final informada pelo host fonte23. É documentação de uma rodada concluída: não descreve nova alteração de código, contrato, script, teste ou screenshot. As melhorias já existentes de arquivos grandes paginados, recuperação, evidências/readiness, foco e Settings/SSH Access foram mantidas; não houve ampliação de funcionalidades nesta tarefa documental.

No momento desta redação, commit, push e CI remoto do futuro commit estavam **pendentes**; resultados de CI antigo não são evidência para este estado. Este snapshot não afirma o estado de publicação posterior.

## Evidências da entrega e revisão

### Evidência relatada pelo host fonte23

A rodada final registrou o seguinte, no checkout fonte23:

| Verificação                                              | Resultado relatado                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                      | exit 0                                                                                                                          |
| `npm run lint`                                           | exit 0; 9 avisos preexistentes                                                                                                  |
| `npm run format:check`                                   | exit 0                                                                                                                          |
| `npm test`                                               | 1.469 passaram, 1 ignorado, 95 arquivos, 66,71 s                                                                                |
| `npm run coverage`                                       | 1.469 passaram, 1 ignorado, 95 arquivos, 73,99 s; pisos de `server/` e `shared/` satisfeitos; cobertura global de linhas 66,23% |
| Build                                                    | exit 0 no fluxo de `npm run test:e2e`                                                                                           |
| `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium npm run test:e2e` | 166/166 passaram, cerca de 3,4 min                                                                                              |
| Regressão visual                                         | 4 specs passaram; 8 PNG originais preservados; o relato inclui os ajustes de SVG/Fontconfig de Access                           |
| `node --test scripts/benchmark-usage.test.mjs`           | 2 passaram                                                                                                                      |

A cobertura global de 66,23% **não** satisfaz nem deve ser descrita como uma meta global de 80%; a afirmação de piso satisfeito se limita aos limiares configurados para `server/` e `shared/`.

### Fluxos Git e retry: fixtures versus execução física

O host separou sondagens de estado das verificações físicas do executor:

- **Store/Orchestrator com metadados sintéticos:** testaram bloqueios quando faltam ponteiro e entrega histórica, em presença de descendentes e diante de fontes contraditórias ou estado `unknown`. São evidência de decisões com fixtures; **não** demonstram que os arquivos correspondentes foram fisicamente entregues.
- **LocalExecutor físico:** um arquivo de 2.097.153 bytes em projeto sem Git levou a captura `unknown` e `secondRetry=false`; com Git, houve checkpoint de um arquivo, `flag=true` e `secondRetry=false`; em projeto realmente vazio e sem Git, `available`, `files=[]`, `flag=false` e `secondRetry=true`.

Na inspeção da baseline suja, o relato foi de que foram retornadas apenas alterações pertencentes à tarefa, com HEAD e índice preservados. Isso não permite concluir que somente um arquivo mudou durante todo o loop. Também foram recuperados worktrees, dependências somente leitura, scratch privado, configuração Git sintética e locks durante o loop. Essa evidência anterior não deve ser confundida com a regressão física da rodada host atual acima.

### Tasks Adelic, revisão e limites de delegação

Segundo os registros das tasks do próprio Adelic, os dois executores documentais foram configurados com modelo `gpt-6-luna`/high e concluíram e integraram suas tasks; o reviewer `ee3c5176...` tem modelo Sol registrado e concluiu a revisão. Essa descrição reflete os modelos registrados/configurados nas tasks, não uma identificação independente do modelo efetivamente inferindo. Tentativas adicionais de delegação por colaboração nativa falharam com `thread-store`/`no rollout found`; não há sucesso comprovado dessas tentativas. Elas são distintas das tasks Adelic concluídas, do benchmark regression-lite e da revisão anterior Sol23.

A revisão Sol23 informou não encontrar defeitos concretos no recorte final de Git. Isso é uma conclusão de inspeção/revisão estática, **não** uma prova dinâmica nem substitui os testes físicos e automatizados listados acima. Este documento não afirma ter repetido esses testes; os resultados quantitativos são os fornecidos pelo host fonte23.

## Benchmark opt-in de regressão — separado do loop principal

O benchmark final foi executado pelo host em backend isolado atualizado fonte23. É uma mini-regressão opt-in, separada dos três exercícios Polyglot e **não é pontuação oficial**. Seu perfil foi regression-lite, com project orchestration, memory e Graphify desativados, as mesmas prompts entre harnesses e Luna/high. Portanto, não se deve confundi-lo com o loop principal orquestrado (orchestration ativa).

Foram quatro turnos, dois harnesses e nenhuma nova tentativa/retry. Os tetos eram 60 s de tempo ativo por turno e 240 s agregados — não limites rígidos de chamadas internas, tokens ou custo. O cancelamento por timeout Adelic pode acrescentar até 50 s.

| Turno       | Harness | Resultado / testes |  Tempo | Entrada reportada | Saída | Entrada em cache | Saída de raciocínio | Ferramentas |
| ----------- | ------- | ------------------ | -----: | ----------------: | ----: | ---------------: | ------------------: | ----------: |
| Reparo      | Adelic  | concluído / passou | 15,3 s |            45.168 |   721 |           28.416 |                 179 |           6 |
| Reparo      | Nativo  | concluído / passou | 12,7 s |            77.941 |   640 |           63.232 |                 142 |           4 |
| Continuação | Nativo  | concluído / passou | 12,2 s |            67.124 |   618 |           63.488 |                 150 |           3 |
| Continuação | Adelic  | concluído / passou | 23,5 s |            79.636 | 1.175 |           65.024 |                 270 |          10 |

A primeira tarefa reparava uma remoção sem distinção de maiúsculas/minúsculas; a segunda adicionava rastreamento de leitura na mesma sessão/espaço de trabalho. A regressão nativa inicia thread Codex persistida e retoma-a no segundo turno; essa persistência é específica deste benchmark. Adelic usou uma única sessão nova para os dois turnos. Essa diferença importa ao interpretar a continuação e não prova retomada nativa equivalente no produto.

Os campos de token são somente os reportados em runtime. A contabilização do Run Adelic e do turno Codex nativo pode diferir; entradas em cache são um campo reportado, não uma base para comparar custo por si só. Custos não foram calculados e são desconhecidos. O número maior de chamadas de ferramentas no follow-up Adelic não constitui, por si, defeito ou menor qualidade: os quatro resultados passaram, e quantidade de ferramentas não mede isoladamente correção, eficiência ou custo.

## Limitações explícitas

- O preview T3 reportou `available=false`; chamadas de abertura repetiram timeout de 15.000 ms. Não houve walkthrough interativo nativo confirmado. O E2E automatizado é evidência separada e não substitui essa experiência.
- Algumas execuções de testes na namespace protegida falharam; a causa não foi confirmada. O host reportou as suítes aprovadas acima. O isolamento permaneceu ativo — não foi desativado para fazer os testes passarem.
- Kiro autenticado e SSH de produção não foram exercitados neste benchmark/validação.
- Sem novo release/deploy informado para este snapshot; pacote registrado como 0.5.3 em develop. No momento da redação, o CI remoto do futuro commit ainda estava pendente.
- A execução desta tarefa limitou-se à documentação. No momento desta redação, antes da publicação, não havia commit nem push; não houve release, deploy nem shutdown nesta tarefa, e a autorização de shutdown havia sido revogada.

## Fontes e insights de harness

As fontes, inferências e limites de evidência estão reunidos no documento canônico [Leituras sobre harness e eficiência — 2026-10-09](harness-source-insights-2026-10-09.md).

## Adendo pós-publicação — acompanhamento

Este adendo complementa o snapshot-fonte23 acima, sem alterar seu estado histórico. O CI **37961354701** do commit **6c4a41e** falhou no timeout de diagnose e em dois testes visuais do Composer. Em verificações posteriores, package/AppImage nas três distros e os dois testes ai-memory passaram. As correções posteriores abrangeram o orçamento de 2 segundos, o SVG do Composer e o estado de criação pendente com fixture independente.

Segundo as verificações focadas relatadas pelo executor, foi atualizado somente `tests/e2e/visual-regression.spec.ts-snapshots/access-1280-linux.png`; em comparação com `HEAD 6c4a41e`, a diferença ficou em 14 pixels no bbox `(4,0)–(13,2)`, junto ao canto arredondado. Os outros sete snapshots, excluindo Access 1280 e Composer 1280/390, permaneceram byteidênticos àquele HEAD. O build passou, a spec visual de 1280/390 passou (4 testes) e `tests/e2e/session-create-composer.spec.ts` passou isoladamente (1 teste). Isso não confirma a causa final da trace da primeira mensagem: a reprodução e o lifecycle são compatíveis com o problema, e o teste com retenção determinística cobre o comportamento futuro, mas não prova a causa histórica.

Os novos checks completos de host e o CI do commit complementar seguem **pendentes**, sob responsabilidade do root. O benchmark Luna/high profile lite já havia obtido **4/4 passes**; não foi repetido porque essas mudanças não alteram a lógica da tarefa mini.
