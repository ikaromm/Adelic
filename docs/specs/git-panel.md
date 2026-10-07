# Painel Git do projeto

2026-10-07. Pedido: ver e registrar no git o que mudou num projeto (status, diff, commit, envio e link de PR) sem sair do Adelic.

## Onde fica

Página **Git** do projeto selecionado, aberta pelo ícone de branch no cabeçalho, na tela do projeto e nas suas conversas (só quando a pasta está num repositório git). Mostra:

- branch atual e upstream com ↑à frente/↓atrás, calculados só com as refs locais (nunca faz `fetch`);
- arquivos alterados em **Staged**, **Não staged** e **Não rastreados**, com a letra de status (M, A, D, R, C, T, U, ?); clicar abre o diff;
- botões por arquivo e **Tudo** para stage/unstage, e descartar por arquivo;
- mensagem e **Fazer commit**; os 20 últimos commits (hash, assunto, autor, data relativa);
- **Enviar (git push)**, só quando a branch tem upstream, e **Abrir pull request**.

## Padrões de segurança

O agente pode escrever em `.git/config` e `.git/hooks`, e o Adelic roda o git fora do sandbox. Por isso:

- Todo comando usa o helper de `server/checkpoints.ts`: `execFile` sem shell, timeout, `GIT_TERMINAL_PROMPT=0`, variáveis `GIT_*` herdadas descartadas, fsmonitor e pager desligados.
- **Hooks desligados**: `core.hooksPath=/dev/null` e `hook.<evento>.enabled=false` para todos os eventos (hooks definidos por `hook.<nome>.command` ignoram o `hooksPath`). O commit usa `--no-verify`. A opção do projeto **Executar hooks do git (pre-commit etc.) ao fazer commit** (desligada por padrão, salva em `project.git.runHooks`) libera os hooks só no commit.
- Filtros clean/smudge/process de qualquer configuração são neutralizados; diffs usam `--no-ext-diff --no-textconv`. Commit sem assinatura GPG.
- Identidade: o commit usa `user.name`/`user.email` do repositório ou do usuário. Se faltar, responde **409 "Configure user.name e user.email no git"** e não configura nada.
- Push: `git push --no-verify <remote> refs/heads/<branch>:<merge>` do upstream configurado, **nunca forçado** (sem `+`, sem `--force`), sem tags, timeout de 2 min e ssh com `BatchMode=yes`. Falha de autenticação vira erro na tela; nenhuma credencial é configurada. É recusado (409) se a configuração local do repositório define algo que faria o push executar um programa ou redirecionar o destino: `core.sshCommand`, `core.askPass`, `core.gitProxy`, `credential.*`, `remote.*.receivepack|uploadpack|vcs`, `url.*.insteadOf`, `protocol.*`, `http.*`. Transportes `ext::` e `fd::` ficam proibidos.
- PR: só monta uma URL de comparação a partir do remote `origin` (https, `ssh://` ou `git@host:`) para github.com e hosts GitLab (`gitlab.com` ou `gitlab.*`), contra `origin/HEAD` (ou `main`/`master`). Credenciais na URL são descartadas. Abre no navegador; no desktop, o tratamento de links externos manda para o navegador do sistema. Nunca usa `gh`.
- Mutações (stage, unstage, descartar, commit, push) respondem **409** enquanto uma execução pode escrever no projeto, um desfazer de checkpoint está em andamento ou outra operação git do painel roda ali; novas execuções nesse projeto recebem 409 enquanto a operação roda. O status informa o motivo em `blocked`.

## Descartar

Arquivo rastreado volta ao conteúdo do índice (`git restore --worktree`); o que está staged é mantido. Arquivo não rastreado é apagado do disco. Arquivo com alterações staged e não staged exige confirmação explícita (`mixed: true`); arquivos em conflito e pastas não são descartados.

## API (`/api/projects/:id/git`)

- `GET repo` → `{ repo }`; `GET status` → branch, upstream, `ahead`/`behind`, `files: [{ path, area, letter, origPath? }]`, `blocked?`, `runHooks`.
- `GET diff?path=&staged=1` → `{ path, staged, diff, truncated }`; `GET log` → `{ commits }`; `GET push-target`; `GET pr-url` → `{ provider, url, base, branch }`.
- `POST stage {paths | all}`, `POST unstage {paths | all}`, `POST discard {paths, confirm: true, mixed?}`, `POST commit {message}`, `POST push {confirm: true}`.

Os caminhos são conferidos contra a lista de status atual (400 para os demais); a saída do git é lida com `-z`, então espaços e acentos funcionam.

## Limites

- Diff de até 200 KB por arquivo (cortado em fim de linha). Status lista até 2000 entradas.
- Mensagem obrigatória, até 5000 caracteres. Sem `amend`, sem criar branch, sem `pull`/`fetch`, sem resolver conflitos.
- Push só para o upstream já configurado; a primeira publicação da branch é feita no terminal.
- Submódulos são ignorados. Nomes de arquivo que não são UTF-8 não aparecem.
