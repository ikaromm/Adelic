# Piloto da harness Adelic 0.5.3 — 2026-10-08

## Resultado

Dois mini projetos criados pelo backend real do Adelic e um piloto de três exercícios públicos comparados com Codex CLI 0.160.0. Ambos resolveram 3/3 exercícios, passando em 53 testes por harness. A amostra é exploratória: não estabelece superioridade nem corresponde ao score oficial do Aider Polyglot.

| Exercício | Testes | Adelic | Codex nativo |
| --- | ---: | ---: | ---: |
| grade-school | 20 | 13,0 s; passou | 14,2 s; passou |
| phone-number | 21 | 27,1 s; passou | 26,3 s; passou |
| transpose | 12 | 35,1 s; passou | 21,2 s; passou |
| Total | 53 | 75,2 s | 61,7 s |

Modelo gpt-6-luna, raciocínio high, uma tentativa formal por tarefa/harness, diretórios e sessões novos, sem feedback dos testes externos para reparo. Adelic: modo deep, Automático, workspace-write, orquestração/Graphify/memória desligados explicitamente. Codex: exec JSON, workspace-write, approval never, ignore-user-config, ignore-rules, ephemeral. Ferramentas e instruções de sistema diferem: compara caminhos reais de execução, não prompts internos idênticos. Não mede delegação, memória, SSH, Kiro ou projetos grandes.

Fonte: [Aider Polyglot](https://github.com/Aider-AI/polyglot-benchmark), commit `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`; [metodologia upstream](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md). Subconjunto escolhido antes de executar: estado/ordenação, validação e transformação de texto. Instruções originais e testes upstream preservados com hashes. Contratos públicos foram explicitados igualmente nos prompts, incluindo formato das listas de grade-school e propriedades/erros de phone-number. Não são as condições do leaderboard oficial.

Testes omitidos dos prompts e dos diretórios de trabalho, executados externamente depois da geração. Os comandos registrados do Codex nativo não mostram leitura dos testes externos. O sandbox nativo não torna esses arquivos necessariamente inacessíveis. Ordem alternada A/N, N/A, A/N; estado de cache e variação de serviço continuam fontes de variação. Tempo medido desde envio ao Adelic/início do CLI; cadastro de projeto/sessão separado.

## Mini projetos e organização

- Lista de tarefas HTML sem dependências: adicionar/concluir/remover, filtros, localStorage, README. Run real 30,6 s. Seis testes funcionais de JavaScript com DOM/localStorage simulados passaram. Isso não verifica layout nem interação em navegador real.
- CLI Python de despesas: CSV, Decimal, JSON ordenado, erros stderr/exit 2, README. Run real 22,6 s. Dez testes gerados pelo modelo passaram; onze verificações independentes adicionais passaram, incluindo precisão decimal, CSV com categoria entre aspas, linhas vazias, cabeçalhos e números inválidos.
- Nove verificações reais da API passaram: criar pasta virtual e filha, mover conversa, não criar diretório real, rejeitar duplicação e pai de outro projeto, arquivar preservando histórico, impedir execução arquivada e restaurar. A tentativa em conversa arquivada foi recusada antes de chamar o modelo.

Servidor isolado em 127.0.0.1:4790, base operacional temporária, providers reais e credenciais existentes mantidas localmente. Sem alterações na base principal, servidor SSH, instalação desktop ou acesso remoto. Preview T3 foi aberto e navegação repetida; retornou chrome-error/timeout e não validou a UI interativamente. Inspeção de usabilidade da interface é baseada no código, separada dos testes reais de backend.

## Achado confirmado: contagem incompleta de tokens

`server/providers/codex.ts` seleciona tokenUsage.last; UsageMeter substitui a leitura anterior. No protocolo observado, last representa a última chamada interna, enquanto total acumula a thread. Como as threads eram novas, os totais finais permitiram auditar cada tentativa formal. O primeiro evento de cada thread tem total igual a last; todas as atualizações seguintes conservam a mesma thread/turn. Em cada uma das três threads, somar as contagens last das 5/9/8 atualizações reproduz exatamente o total final, confirmando a contabilização por chamada interna.

| Exercício Adelic | Entrada exibida | Entrada total auditada | Saída exibida | Saída total auditada |
| --- | ---: | ---: | ---: | ---: |
| grade-school | 6.792 | 30.742 | 89 | 776 |
| phone-number | 8.612 | 66.026 | 46 | 1.587 |
| transpose | 8.130 | 55.602 | 242 | 2.285 |

Auditoria temporária envolveu o callback de notificações do provider, sem modificar seu comportamento ou arquivos de produção. Registrou somente tokenUsage e identificadores de thread/turn, sem prompts, credenciais ou saídas. As threads foram correlacionadas com cada run por correspondência única das contagens finais last e execução serial. Os números originais da API foram preservados. O tempo do Adelic inclui pequena sobrecarga de gravação dessa instrumentação.

| Caminho formal | Entrada total | Entrada em cache | Entrada sem cache | Saída total |
| --- | ---: | ---: | ---: | ---: |
| Adelic auditado | 152.370 | 103.168 | 49.202 | 4.648 |
| Codex JSON | 210.440 | 182.016 | 28.424 | 4.519 |

Não transformar esses totais em preço ou economia financeira: custo não informado, cache distinto e amostra pequena. O protocolo informa reasoningOutputTokens dentro da auditoria; não somá-los novamente à saída. Os valores da tabela cobrem apenas a rodada formal, não os mini projetos nem a preparação. Seis tentativas não significam seis chamadas internas do modelo. Teto de 180 s por tentativa não é teto rígido de tokens/dinheiro.

Na preparação, um coletor externo situado em /tmp não ficou visível no sandbox e uma tentativa Adelic falhou antes da execução do modelo; uma tentativa nativa de grade-school usou contrato ambíguo e falhou, e uma tentativa nativa de phone-number foi interrompida. Esses registros foram preservados e excluídos da rodada formal. O consumo da tentativa interrompida não foi recuperado. Não apresentar a rodada formal como consumo total de toda a investigação.

## Melhorias recomendadas, em ordem

1. **Corrigir a contabilização por turno.** Auditar total menos baseline da thread para continuações; tratar retomada/retry/delegação sem duplicação e preservar cache/raciocínio como campos separados. Validar contra protocolo real e conectar aos limites existentes. Aceitação: a reprodução da trilha capturada de grade-school mostra 30.742/776, e turnos seguintes não contam histórico anterior outra vez.
2. **Alinhar ferramentas anunciadas com o executor isolado.** Em phone-number, o modelo tentou fileChange nativo, recebeu declined e precisou editar por exec. Orientar o runtime sobre capacidades efetivas e oferecer edição/patch no executor com a mesma validação de caminhos e isolamento. Não liberar ferramentas nativas para contornar segurança. Aceitação: edição no Automático ocorre pelo executor sem tentativa bloqueada desnecessária.
3. **Facilitar criar um projeto local.** ProjectForm pede caminho digitado; projectPath exige diretório existente. Oferecer selecionar/criar pasta e diagnóstico de escrita no formulário, com confirmação concreta da pasta alvo. Aceitação: começar um projeto vazio sem preparar o diretório no terminal.
4. **Mostrar o perfil efetivo antes do primeiro envio.** Padrões de orquestração/Graphify continuam ativados; oferecer escolha explícita de execução leve para tarefa pequena e exibir modelo, raciocínio, escrita/autonomia, memória e delegação. Os controles já existem depois do cadastro; melhorar descoberta sem trocar padrões silenciosamente.
5. **Entrega acompanhada de evidências de validação.** Ampliar hooks/RunChecks existentes: comando executado, resultado e o que não foi verificado. Separar teste real, análise estática e afirmação do agente. Um parsing HTML não ganha badge de UI testada. Aceitação: checklist revela quais requisitos têm evidência independente.
6. **Resumo de artefatos útil também sem Git.** Nos mini projetos, checkpoint ficou indisponível por não serem repositórios Git. Exibir arquivos criados/alterados observáveis, acesso ao projeto e atalho ao terminal/preview existente; oferecer inicializar Git explicitamente quando o usuário quiser desfazer com checkpoints. Não afirmar backup onde não existe.
7. **Contexto de capacidades enxuto para evitar chamadas inúteis.** Informar se existe Git e os comandos de verificação conhecidos. transpose tentou git status e recebeu exit128. Evitar releituras repetidas da mesma instrução e expor recursos úteis sem carregar todo o contexto global. Medir redução de passos, mantendo qualidade e isolamento.
8. **Transformar este piloto em regressão reproduzível.** Manter casos públicos versionados mais pequenos casos próprios de criar/reparar projeto e preservar contexto em segundo turno. Executar poucos casos por mudança de harness e expandir/alternar amostra periodicamente. Medir pass@1, tempo, ferramentas, aprovação/intervenção e uso auditado; não escolher casos depois de conhecer o resultado.

## Reprodução e evidências

Runner: `node scripts/benchmark-harness.mjs --dry-run` / `--preflight` não chamam modelos; `--run` usa os modelos reais. Requer checkout upstream no SHA acima e um servidor Adelic descartável previamente iniciado. O runner altera configurações desse servidor: nunca apontar para a base pessoal. Caminhos configuráveis por ADELIC_BENCHMARK_ROOT, ADELIC_POLYGLOT_ROOT, ADELIC_CODEX_BIN e ADELIC_BENCHMARK_URL.

Artefatos locais em `/tmp/adelic-harness-eval/`: `results.json` e `report.md` com leituras originais, `audited-results.json`, `usage-audit.jsonl`, testes/logs/códigos gerados e resultados independentes. O runner sozinho não inclui a instrumentação de auditoria temporária: suas contagens do Adelic continuam exibindo o dado original do produto. Diretório temporário sujeito a limpeza pelo sistema.

Somente script de avaliação e este relatório foram adicionados ao checkout. Sem correção de produção, commit, push ou release nesta investigação. Runner passou em sintaxe, ESLint e Prettier; testes executados nesta etapa são os do piloto descrito, não nova execução de toda a suíte do Adelic.
