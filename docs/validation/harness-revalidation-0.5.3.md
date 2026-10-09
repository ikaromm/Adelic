# Revalidação da harness após o piloto 0.5.3 — 2026-10-08

## Resultado observado

As oito melhorias do [piloto](harness-pilot-0.5.3.md) foram implementadas no checkout: contabilização acumulada, edição isolada `replace_text`, navegador/criação local de pastas, perfil leve explícito, configuração visível antes do envio, comandos de checks como evidência, entrega para projetos sem Git e regressão reproduzível. O [contrato de entrega](../specs/harness-delivery.md) detalha limites e escopo.

A versão do pacote permanece 0.5.3. Esta etapa não criou commit, push, release ou deploy e não substituiu a instalação pessoal.

## Mesmos três exercícios públicos

Modelo `gpt-6-luna`, esforço high, Codex CLI 0.160.0; mesmas condições do piloto. Adelic deep, automático, workspace-write, coordenação/Graphify/memória desligados explicitamente; nativo exec efêmero workspace-write sem configurações/regras pessoais. Uma tentativa por tarefa e caminho, testes externos sem feedback para reparo. Os hashes das instruções, testes e prompts foram comparados com os artefatos da rodada **formal** anterior e são idênticos em todos os três casos. Fonte Aider Polyglot no SHA `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`.

| Exercício | Testes por caminho | Adelic antes | Adelic depois | Codex antes | Codex depois |
| --- | ---: | ---: | ---: | ---: | ---: |
| grade-school | 20 | 13,045 s | 15,050 s | 14,235 s | 18,338 s |
| phone-number | 21 | 27,076 s | 25,068 s | 26,278 s | 21,080 s |
| transpose | 12 | 35,091 s | 30,074 s | 21,216 s | 27,171 s |
| Total | 53 | 75,212 s | 70,192 s | 61,729 s | 66,589 s |

**Os dois caminhos passaram em 3/3 exercícios e 53/53 testes.** Adelic ficou 6,7% mais rápido nesta rodada, mas ainda levou 5,4% mais tempo que o nativo nesta amostra. Variação de serviço, raciocínio e cache impede atribuir toda a diferença às mudanças ou generalizar superioridade.

| Adelic | Antes, auditoria corrigida | Depois, API e protocolo |
| --- | ---: | ---: |
| Entrada total | 152.370 | 122.885 |
| Entrada em cache | 103.168 | 82.432 |
| Entrada sem cache | 49.202 | 40.453 |
| Saída total | 4.648 | 5.037 |
| Chamadas de ferramentas | 17 | 15 |

A entrada caiu 19,4%; a saída cresceu 8,4%. Isso não equivale a economia financeira. O nativo reportou 261.992 tokens de entrada, 225.280 em cache e 4.458 de saída na rodada nova. Preços/custos não foram inferidos.

A auditoria temporária registrou apenas IDs e notificações de uso. Para **cada** run público do Adelic, entrada, saída, cache e raciocínio da API coincidiram exatamente com `tokenUsage.total` final: grade-school 32.026/927/21.504/312; phone-number 34.355/1.955/17.664/923; transpose 56.504/2.155/43.264/1.263. Threads novas tornam a linha de base zero. Cache já integra entrada; raciocínio já integra saída.

As três execuções terminaram sem aprovação pendente ou intervenção humana. transpose teve dois comandos de autoavaliação que falharam por expectativas de whitespace criadas pelo modelo; o modelo corrigiu essas expectativas e os 12 testes externos passaram. Isso não foi ocultado como execução inteiramente sem falhas de ferramentas. Não houve tentativa Git desnecessária nos comandos observados desta rodada.

A entrega complementar registrou estado disponível e um arquivo modificado/criado em cada run público, mesmo sem Git.

## Regressão própria em dois turnos

Fixture versionada de lista de leitura: primeiro reparar remoção sem distinguir maiúsculas/minúsculas; depois adicionar rastreamento de leitura, preservando comportamento anterior e contexto. Dois testes de reparo e um teste de continuação com múltiplas asserções, sempre externos ao workspace do modelo.

**Adelic e Codex passaram nos dois turnos (3/3 testes por caminho).** Adelic usa a mesma conversa com histórico limitado e threads efêmeras novas; nativo usa uma thread persistida e `exec resume`. Isso verifica continuidade de comportamento nesta fixture, não retomada nativa do Adelic. Não houve aprovação pendente/intervenção humana; a entrega observou a alteração de `reading_list.py` nos dois turnos do Adelic. Os quatro campos de uso desses dois runs também coincidiram com a auditoria de protocolo.

Uma rodada preparatória foi invalidada porque o runner não repetiu workspace-write no `exec resume`, que voltou somente leitura. Essa rodada foi preservada separadamente e **não conta como falha comparável da harness nativa**. O runner foi corrigido e os dois caminhos repetidos em diretórios/sessões novos.

O JSON do `exec resume` contém o acumulado da thread, conforme o [conversor oficial da versão 0.160.0](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs). O runner desconta o snapshot anterior. Na rodada final, o segundo turno nativo reportou 128.990 tokens de entrada acumulados; descontando os 78.372 do primeiro, o consumo do segundo foi 50.618. O valor bruto foi preservado e a normalização aplicada aos JSONL existentes, sem nova chamada ao modelo. Dois testes offline protegem esse cálculo e tratam linha de base ausente/contador regressivo como desconhecido.

Os tempos da regressão própria não são comparação de performance: houve checks do repositório executados simultaneamente. Limites são de tempo ativo por tentativa, não de chamadas internas ou tokens. Esta revalidação realizou 14 tentativas de turno: seis públicas e oito preparatórias/finais de regressão. Cada tentativa pode envolver várias chamadas internas ao modelo.

## Validação do produto

A revisão independente Sol/Astra encontrou e corrigiu: transporte SSH que não aceitava `replace_text`, leitura sem limite nessa edição, seleção implícita de HOME, criação em pasta antiga após navegação, snapshots parciais afirmando alterações, leitura de artefato por raiz substituída por symlink e ação Git histórica atingindo o projeto atualmente vinculado.

O teste de transporte usou sshd local real, incluindo substituição e leitura de volta. Os demais testes de provider usam fixtures; este benchmark não executou Kiro autenticado nem SSH de produção. Leituras de arquivos rejeitam traversal, arquivo não listado, cliente remoto e raiz redirecionada. Inicialização Git exige confirmação e recusa repositórios existentes ou herdados do pai.

Typecheck, lint, formatação e build passaram. Lint mantém nove avisos preexistentes, sem erros. A suíte de unidade final passou em 89 arquivos: 1.363 testes passaram e um foi ignorado, usando `npm test -- --maxWorkers=2`. A execução padrão também chegou a passar antes dos últimos ajustes, mas execuções concorrentes posteriores tiveram timeouts/SIGKILL; os logs foram preservados, e o comando com dois workers validou a árvore final. Dois testes Node adicionais do cálculo de uso passaram. A suíte completa final de navegador passou: **138/138 testes**, incluindo entrega em 390 px, criação de pasta/perfil leve, comandos de checks, interface em inglês e revinculação sem ações no projeto errado. O preview T3 foi aberto e tentou navegação por environment-port e URL local; retornou `chrome-error://chromewebdata/` apesar de HTTP local 200. A validação interativa pelo preview permanece indisponível, separada dos testes automatizados de navegador.

## Reprodução e evidências

```sh
ADELIC_BENCHMARK_ROOT=/tmp/adelic-harness-public-reproduction \
ADELIC_POLYGLOT_ROOT=/tmp/adelic-harness-eval/polyglot \
node scripts/benchmark-harness.mjs --run

ADELIC_BENCHMARK_ROOT=/tmp/adelic-harness-regression-reproduction \
node scripts/benchmark-harness.mjs --run --suite regression

node --test scripts/benchmark-usage.test.mjs
```

É necessário iniciar primeiro um backend isolado. O runner muda permissões/configurações desse backend; nunca apontá-lo à base pessoal. Preflight/dry-run não chamam modelos. A instrumentação externa de auditoria não faz parte do runner do produto.

- `/tmp/adelic-harness-eval/`: baseline e preparação original, preservados.
- `/tmp/adelic-harness-after/`: rodada pública nova, preparação inválida da regressão, logs, detalhes locais, auditoria, `usage-verification.json` e `delivery-verification.json`.
- `/tmp/adelic-harness-regression-final/`: rodada válida de dois turnos, testes/JSONL e `usage-verification.json`; `regression-results-reported.json` preserva as contagens nativas brutas, `regression-results.json`/`regression-accounting.md` contêm a normalização.

Artefatos em `/tmp` estão sujeitos à limpeza do sistema; o relatório versionável registra o resultado e os limites sem credenciais ou transcrições. O servidor descartável foi encerrado após capturar as evidências; a base pessoal e o bind remoto permanecem intactos.
