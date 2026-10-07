# Checkpoints: o que cada execução alterou, e desfazer

2026-10-06. Pedido: ver o que cada execução mudou nos arquivos do projeto e poder desfazer, sem nunca mexer no trabalho do usuário no git.

## Quando há checkpoint

Antes de uma execução que pode escrever (sandbox `workspace-write` e execução com ferramentas ou orquestrada), se a pasta do projeto está num repositório git, o Adelic grava um retrato dos arquivos. Ao terminar, grava outro e calcula a lista de arquivos alterados.

- Pasta que não é repositório git: a execução registra `checkpoint: { available: false, reason: 'não é um repositório git' }`.
- Conversa avulsa: só quando a pasta própria da conversa é a raiz de um repositório (nunca um repositório que a contenha).
- Projeto numa subpasta de um repositório: só os arquivos dessa subpasta entram.
- Execução que não mudou nada: lista vazia e nenhuma ref fica gravada.

## Como é gravado (`server/checkpoints.ts`)

Os retratos são commits em `refs/adelic/checkpoints/<runId>/before` e `/after`, montados com um índice temporário próprio (`GIT_INDEX_FILE` em uma pasta temporária): `ls-files` lista arquivos rastreados e não rastreados (respeitando `.gitignore`), `hash-object -w --no-filters` grava o conteúdo, `update-index` + `write-tree` + `commit-tree` montam o commit e `update-ref` cria a ref.

**Nunca tocados:** HEAD, branches, tags, o índice real, o stash e a árvore de trabalho. Os testes conferem HEAD, refs, stash, bytes do `.git/index` e `git status` antes e depois. A única escrita fora de `refs/adelic/` são os objetos novos em `.git/objects`.

**Configuração do repositório não executa nada:** o conteúdo é lido como bytes crus, então filtros clean/smudge, `textconv`, diff externo e conversão de fim de linha não rodam. Hooks (`core.hooksPath=/dev/null`), fsmonitor, objetos de substituição e pager ficam desligados, e variáveis `GIT_*` herdadas são descartadas. Isso importa porque o agente pode escrever em `.git/config` e o Adelic roda o git fora do sandbox. Todo comando usa `execFile` (sem shell), timeout de 2 min, `GIT_TERMINAL_PROMPT=0` e saída `-z` (nomes com espaço e acentos).

## API

- `GET /api/runs/:id/changes` → `{ available, reason?, files: [{ path, status: added|modified|deleted, additions, deletions, binary? }], omitted?, restoredAt? }`.
- `GET /api/runs/:id/diff?path=…` → `{ path, diff, truncated }`, diff unificado de até 200 KB. Só aceita caminhos da lista da execução (404 para os demais).
- `POST /api/runs/:id/restore` com `{ "confirm": true }` → desfaz.

## Desfazer

Para cada caminho alterado pela execução, o Adelic confere se o arquivo ainda é exatamente o que a execução deixou (conteúdo, bit de execução, link simbólico). Se algum não for, responde **409 com a lista desses arquivos e não altera nada**: edições posteriores nunca são sobrescritas. Se todos conferem, grava o conteúdo de antes nos arquivos alterados ou removidos (escrita em arquivo temporário + `rename`) e apaga os criados pela execução, junto com pastas que ficarem vazias.

Também recusa (409): enquanto qualquer execução estiver ativa na mesma pasta (e novas execuções ali recebem 409 enquanto o desfazer roda), uma segunda vez, e caminhos que passariam por um link simbólico. Se as refs foram apagadas ou reescritas no repositório, responde 410.

Na tela, o painel de atividade mostra "Alterou 3 arquivos (+12 −4)"; cada arquivo abre o diff, e **Desfazer alterações desta execução** pede confirmação explicando o que volta e que edições posteriores bloqueiam.

## Limites

- Arquivos ignorados pelo `.gitignore`, pastas vazias, submódulos e repositórios aninhados não entram no retrato, nem são desfeitos.
- Se o usuário editar arquivos durante a execução, essas edições aparecem como alterações da execução.
- Sem checkpoint (indisponível) quando a pasta passa de 100 mil arquivos, um arquivo passa de 50 MB, o total passa de 1 GB, há nomes que não são UTF-8 ou o git falha; o motivo fica na execução.
- Cada execução relê e grava o hash de todos os arquivos não ignorados, o que custa tempo em projetos grandes.
- A lista mostra até 500 arquivos; acima disso, o desfazer fica desativado na tela.
- O agente pode alterar `.git` durante a execução (ele está na pasta gravável); refs adulteradas são detectadas e o desfazer é recusado.
- As refs não são apagadas automaticamente. Para limpar: `git for-each-ref --format='delete %(refname)' refs/adelic/ | git update-ref --stdin`.
- Execuções interrompidas por reinício do servidor ficam só com o retrato `before`, sem lista nem desfazer.
