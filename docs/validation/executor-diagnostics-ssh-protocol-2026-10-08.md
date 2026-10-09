# Diagnóstico prévio e categorias do executor — 2026-10-08

## Alterações

- `server/local-executor.ts` exporta `preflightLocalExecutor`, verificando Linux, bubblewrap, Python 3 e caminho de projeto antes de iniciar um processo de ferramenta. Falhas de preflight trazem causa permitida e orientação acionável; a criação do executor não inicia ferramenta se houver bloqueio.
- `server/remote/runner-source.ts` classifica erros por tipo e casos de validação conhecidos. Mensagens arbitrárias de exceções não atravessam o protocolo; categorias continuam na lista limitada `timeout | not_found | permission | invalid_request | conflict | executor`. Arquivo grande, UTF-8 inválido e substituição ausente/ambígua têm diagnósticos estáveis.
- `server/remote/transport.ts` aceita erro SSH legado sem `errorCategory` e resposta nova com categoria. Categorias permitidas são reconstruídas no objeto Error; categoria inválida é descartada sem encerrar a conexão. Mensagem remota só é conservada se pertencer a uma lista explícita de textos seguros.
- `server/local-executor.ts` aplica a mesma validação/reconstrução no JSONL local.
- `server/providers/remote-tools.ts` sugere recuperação por categoria e por alguns diagnósticos seguros: conferir caminho com `stat/list`, usar `search` em arquivo acima do limite, conferir UTF-8 e reler estado antes de repetir substituição ambígua.
- Testes cobrem preflight, erros categorizados/sanitizados no runner local isolado, orientação sem ecoar valores sintéticos e cenário de transporte SSH com categoria válida, ausente e inválida.

## Evidência observada

Executados no checkout:

- `npm test -- --run tests/remote-runner.test.ts tests/local-executor.test.ts tests/remote-providers.test.ts tests/remote-transport.test.ts`: **4 arquivos aprovados; 20 testes passaram, 2 foram ignorados**. Reconstrução SSH foi exercitada também pelo helper de protocolo nos casos categoria válida, ausente e inválida.
- `npx prettier --check` nos sete arquivos alterados: passou.
- `npx eslint` nos sete arquivos alterados: passou, sem erros.
- `npm run typecheck`: passou.
- Runner exercitado de fato em testes do protocolo e executor local com bubblewrap, incluindo caminho ausente, substituição ambígua e segredo sintético; os erros mantiveram categoria e não ecoaram o segredo.

**Limite importante:** os dois testes de integração da suíte SSH foram ignorados pelo próprio setup. Embora `/usr/bin/ssh` e `/usr/bin/sshd` existam, o ambiente não define `USER` e não possui entrada de usuário para UID 1000; o teste existente exige `USER` para iniciar o daemon local. Portanto, nesta execução não afirmo validação SSH real ponta a ponta. O teste para fazê-la está preparado para daemon/runner descartáveis locais, mas precisa ser executado em ambiente de teste com usuário válido. Nenhum host de produção foi contatado.

A suíte completa, build e E2E não foram executados nesta alteração. Nenhum commit, publicação ou deploy foi feito.
