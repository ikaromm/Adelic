# Perfil de navegação e edição: experimento focalizado

## Objetivo e escopo

Este perfil local orienta executores em tarefas pequenas de manutenção: localizar símbolos por busca, ler somente o contexto necessário e editar com uma revisão atual. O catálogo de skills existente seleciona pelo nome explícito; descrições genéricas não ativam corpos, que são lidos quando uma skill é selecionada; este pacote não importa catálogos externos nem altera ferramentas, controles, permissões ou mecanismos de revisão.

Para habilitá-lo no catálogo runtime, copie `skills/navigation-edit/skill.json` e `SKILL.md` para `<dataDir>/skills/navigation-edit/`. A fonte versionada aqui não é automaticamente carregada pelo catálogo. O manifesto limita o papel a `worker`.

## Protocolo fixado

Tarefa idêntica nas duas condições: no fixture sintético `tests/fixtures/navigation-edit/large-maintenance-fixture.ts`, alterar somente `export const maintenanceFlag = false;` para `export const maintenanceFlag = true;`. A tarefa, fixture, permissões workspace-write e ferramentas do executor são as mesmas; cada condição começou de uma cópia idêntica, fora a revisão de metadados própria da cópia.

- **Sem perfil (baseline):** ler `baseline.ts` sequencialmente com `read_file` (`offset=0`, depois `nextOffset`, `limit=49152`) até `truncated=false`; fazer a substituição localizada via `replace_text` com `expectedRevision` da página atual.
- **Com perfil:** buscar `maintenanceFlag` em `profile.ts`; ler a página necessária em `offset=0, limit=2200`; substituir o trecho usando a revisão dessa leitura.
- Contar uma chamada por operação do executor (incluindo páginas de leitura e busca). Somar `bytesRead` somente para o conteúdo retornado por `read_file`. Registrar separadamente tamanho serializado em caracteres do resultado de busca, sem somá-lo como bytes de leitura. Não usar estes números como tokens.
- Critério de comparação: concluir exatamente a mesma edição; comparar chamadas e bytes de `read_file`. Fixar tarefa e limites antes de medir, sem iterar parâmetros em função dos resultados.

Para repetir manualmente, crie duas cópias novas do fixture dentro do executor sob os nomes `baseline.ts` e `profile.ts`, execute as sequências acima, registre os campos numéricos das respostas e remova as cópias. Não conte preparação/limpeza como chamadas da tarefa. `replace_text` deve receber a revisão atual observada; não altere mecanismo nem permissões.

## Evidência desta execução

Executor local isolado; tarefa executada uma vez por condição pelas ferramentas reais do executor. Ambos os resultados confirmaram uma correspondência e a edição da mesma linha.

| Condição | Chamadas | Bytes de conteúdo em `read_file` | Outros dados observados |
| --- | ---: | ---: | --- |
| Sem perfil | 3 (2 páginas + edição) | 53.542 | — |
| Com perfil | 3 (busca + leitura + edição) | 2.200 | resultado serializado da busca: 454 caracteres |

A observação mostra menos bytes lidos nesta fixture para a condição guiada pelo perfil, sem redução de chamadas neste caso. Não prova causalidade, generalização nem redução de tokens. O tamanho em caracteres da busca é reportado à parte, não confundido com bytes lidos. Não foram armazenados conteúdos de usuário; fixture e saída são sintéticos e sanitizados.

## Limitações

- Experimento manual focalizado de uma fixture e uma execução por condição; não é benchmark de modelo, teste em tarefa real, medição de latência ou análise de custos.
- Métricas são contagens das chamadas feitas e do campo `bytesRead` observado no executor. Não medem bytes internos de protocolo, prompt enviado ao modelo ou contexto acrescentado pelo runtime.
- A versão de leitura pontual começa no offset zero nesta fixture porque o símbolo foi colocado perto do início. Uma tentativa exploratória anterior à medição para ler diretamente no offset 26.500 retornou erro de leitura e pediu reinício em offset 0; não foi contada como medida. O layout final foi fixado antes das duas condições medidas. O experimento não caracteriza leitura por offset arbitrário.
- A seleção do corpo da skill no produto depende da instalação no `dataDir`; este teste verifica a orientação versionada e o protocolo, não uma execução de modelo com a skill ativa.
- Qualquer edição ou formatação invalida revisão anterior. Releia antes de usar revisão para nova edição. Nenhum teste deste escopo altera revisão esperada, lock, gravação atômica ou permissões.
