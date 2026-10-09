# Leituras sobre harness e eficiência — 2026-10-09

Este documento registra fontes públicas consultadas pelo host em 2026-10-09 e hipóteses para trabalho futuro no Adelic. É um snapshot **ANTES DA PUBLICAÇÃO**: no momento da redação, commit, push e CI remoto do futuro commit estavam pendentes; não afirma estado posterior. Resumos de fonte e inferências locais estão separados; links junto das afirmações. Não é especificação nem mudança de comportamento.

## Roteamento de modelos

**Fontes.** A página do YouTube confirma o título _How to Build a Model Router in the Harness_; texto e transcrição não estavam disponíveis, portanto nenhum conteúdo técnico é atribuído ao vídeo ([YouTube](https://www.youtube.com/watch?v=5kTFyEOgark)). A fonte técnica complementar da LangChain, publicada em 2026-10-01, trata de roteamento na harness condicionado ao contexto da tarefa: primeiro mapear usos, selecionar níveis de custo/capacidade e avaliar qualidade e latência ([LangChain](https://www.langchain.com/blog/how-to-build-a-model-router-in-the-harness)).

**Inferência para Adelic.** Como experimento futuro, registrar a decisão, motivo e modelo efetivo e medir tarefas pequenas e delegadas pode tornar o roteamento auditável. A regra local vigente exige caminho curto determinístico para perguntas simples, sem chamada adicional de classificador/modelo ([AGENTS.md](../../AGENTS.md)). Não se transfere ao Adelic a redução de 64% reportada no estudo da LangChain. Segundo os registros das tasks do próprio Adelic, os dois executores documentais foram configurados com `gpt-6-luna`/high e concluíram/integraram suas tasks; o reviewer `ee3c5176...` tem modelo Sol registrado e concluiu. Isso informa o modelo registrado/configurado, não uma identificação independente do modelo efetivamente inferindo. As tentativas adicionais de delegação por colaboração nativa falharam com `thread-store`/`no rollout found`, sem sucesso comprovado; são distintas das tasks Adelic concluídas, do benchmark Luna/high descrito abaixo e da revisão anterior Sol23. As fontes não justificam trocar modelos.

## Skills e fluxos de trabalho

**Fontes.** O catálogo [AI Hero](https://www.aihero.dev/skills) organiza skills ao longo de fluxos como ideia, especificação, tickets, implementação, revisão e retrospectiva, com instruções invocadas pontualmente. A release [Matt Pocock Skills v1.3.1](https://github.com/mattpocock/skills/releases/tag/v1.3.1) descreve um grafo de tarefas e uso de worktrees, integração/revisão e retrospectiva; também registra que checks determinísticos podem capturar erros mecânicos, enquanto frontmatter YAML inválido e invocações implícitas de outras skills são fontes de falha.

**Inferência para Adelic.** Carga sob demanda, gatilhos explícitos, referência clara à origem e validação do catálogo são ideias para avaliar. Estados e integração explícitos, com regressões para defeitos observados, também são práticas compatíveis com a experiência registrada em [revalidação da harness](harness-revalidation-0.5.3.md). Isso não autoriza instalar/carregar todo o catálogo, copiar instruções externas para `AGENTS.md` ou ampliar permissões. Worktrees e grafos externos não justificam adotar fast-forward cegamente: a integração do Adelic precisa preservar um checkout do usuário que possa estar dirty.

## Compressão e vetores

**Fonte.** O artigo do Google Research, de 2026-03-24, apresenta TurboQuant como quantização de vetores para KV cache em backend de inferência e busca vetorial, com experimentos envolvendo modelos abertos ([Google Research](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/)).

**Inferência para Adelic.** Isso não equivale a resumir conversas e não otimiza diretamente o KV cache de Codex/Kiro remoto pela UI do Adelic. Uma aplicação potencial exigiria backend de inferência local ou índice vetorial sob controle do produto e benchmark de qualidade. Não se devem prometer reduções de tokens, faturamento ou multiplicadores 64/6/8x. Como prioridades mais próximas, esta análise sugere contexto seletivo, artefatos paginados e medição do uso que a harness realmente disponibiliza — não uma nova camada de modelo para perguntas simples.

## Limite de evidência do segundo vídeo

A consulta de https://www.youtube.com/watch?v=BsJGo1wFTvQ falhou com Cache miss; sua transcrição não foi verificada. Resumos secundários encontrados não foram usados como evidência. Assim, este relatório não atribui afirmações técnicas a esse vídeo, nem afirma que qualquer vídeo foi assistido ou transcrito.

## Medição exploratória separada

O host executou um mini projeto opt-in de regressão, separado dos três exercícios Polyglot e sem valor de score oficial. No modo regression-lite, o perfil reportado tinha orquestração, memória e Graphify desativados; foram quatro turnos (reparo e continuação em cada harness), sem retry, usando Luna/high. O modo nativo retomou uma thread persistida; os dois turnos Adelic ocorreram numa sessão nova. Todos os turnos concluíram e passaram os testes. A sequência nativa foi mais rápida no reparo (12,7 s contra 15,3 s), e Adelic mais lenta na continuação (23,5 s contra 12,2 s); são poucas observações, não evidência de superioridade ou defeito. O benchmark da revalidação do produto, com outras condições, está documentado separadamente em [harness-revalidation-0.5.3.md](harness-revalidation-0.5.3.md).

Os campos de tokens foram os reportados em runtime, não uma contabilidade comum auditada entre harnesses: entrada reportada de 45.168–79.636, entrada em cache de 28.416–65.024, saída de 618–1.175 e raciocínio de 142–270. As chamadas de ferramenta reportadas foram 3–10 por turno. Não se infere custo, economia nem comparabilidade financeira. Teto ativo de 60 s por turno (240 s agregado) não é orçamento rígido de tokens/chamadas/custo; o cancelamento pode acrescentar tempo. Contagem maior de ferramentas não prova defeito. Cadência de status e eventual escalonamento podem ser medições futuras, não mudanças implementadas aqui.

## Contexto local e limites

A documentação existente registra que a harness mede caminhos de execução diferentes e que custos não são inferidos a partir de tokens ([piloto](harness-pilot-0.5.3.md), [revalidação](harness-revalidation-0.5.3.md)). No preview nativo T3, o host registrou status indisponível (`available=false`) e repetidos timeouts de `open` após 15 s; não houve walkthrough interativo. E2E automatizado é evidência separada ([implementação de usabilidade](usability-implementation-adelic-0.5.3.md)). São fatos reportados pelo host e referências preexistentes, não uma nova execução ou confirmação independente neste arquivo.

Este texto não implementa roteamento, skills, compressão ou medição, nem altera código, testes, scripts, assets, screenshots, contratos ou permissões. Não houve release ou deploy nesta tarefa documental.
