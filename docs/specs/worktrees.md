# Cópia isolada (worktree) por conversa

2026-10-07. Pedido: deixar um agente trabalhar numa conversa sem mexer na pasta do projeto, e trazer o resultado só quando o usuário decidir.

## Como funciona

- Numa conversa vinculada a um projeto cuja pasta é a raiz de um repositório git com pelo menos um commit, o painel acima da conversa mostra **Trabalhar em uma cópia isolada (worktree)**. Fica desativado durante uma execução.
- Ao ligar: `git worktree add -b adelic/<8 caracteres do id>-<título> <dados>/worktrees/<sessionId> HEAD`. A pasta fica nos dados operacionais do Adelic, fora do repositório do usuário. A conversa grava `Session.worktree = { path, branch, base, createdAt }` (no JSON de `sessions.data`, sem migração) e perde a sessão nativa do agente, que conhecia a outra pasta.
- As execuções da conversa usam a cópia como `cwd`: sandbox (o bubblewrap libera a escrita na pasta da execução), checkpoints e desfazer, menções `@arquivo` (inclusive a lista do autocompletar) e compactação/passagem de agente. O índice do Graphify continua sendo o do projeto.
- Execuções na cópia não ocupam a reserva de escrita do projeto: rodam ao mesmo tempo que execuções na pasta principal. Duas execuções na mesma cópia continuam em fila.
- O painel mostra o branch, "N arquivos alterados em relação a <base>" (commits do branch e alterações não commitadas, sem os ignorados) e as ações:
  - **Ver alterações**: lista de arquivos com o diff de cada um (até 200 KB).
  - **Aplicar no projeto** (confirmação): faz commit do que está pendente na cópia com a mensagem `Adelic: <título>` (identidade Adelic só se o repositório não tiver `user.name`/`user.email`) e, na pasta principal, roda `git merge --no-ff <branch>`.
  - **Descartar worktree** (confirmação): `git worktree remove --force` e apaga o branch só se ele não tiver commits fora do projeto ou se o usuário marcar "Apagar o branch também".
- Apagar a conversa remove a cópia; o branch fica, a menos que já esteja no projeto. Ao iniciar, registros cuja pasta sumiu são removidos e `git worktree prune` limpa o repositório.
- Com a cópia ligada, a conversa não muda de projeto (409); descarte antes.

## Garantias

- **A pasta principal só é alterada pelo "Aplicar no projeto"**, e só quando ela está sem alterações (`git status` vazio, inclusive arquivos não rastreados), em um branch (não em HEAD destacado) e sem merge, rebase ou cherry-pick em andamento. Senão: 409 com o motivo. Nada é guardado no stash, resetado ou trocado de branch.
- Se o merge der conflito, o Adelic roda `git merge --abort` e devolve 409 com a lista de arquivos; a pasta principal fica como estava. O commit na cópia permanece no branch.
- Se o branch cria um arquivo que existe na pasta principal como ignorado, o merge é recusado (o git o sobrescreveria sem avisar).
- Recusado (409) enquanto houver execução, plano ou outra operação da cópia na conversa, ou execução, desfazer ou outro "Aplicar" na pasta principal; novas execuções ali recebem 409 enquanto o merge roda.
- Todo comando usa o git endurecido de `server/checkpoints.ts` (`execFile` sem shell, timeout, `GIT_TERMINAL_PROMPT=0`, variáveis `GIT_*` herdadas descartadas). Além disso: hooks de todos os eventos desligados (`core.hooksPath=/dev/null` e `hook.<evento>.enabled=false`), filtros clean/smudge/process e drivers de merge do repositório anulados, `--no-verify`, sem autostash. O agente pode escrever na cópia, e o Adelic roda o git fora do sandbox.
- Os comandos na cópia usam o `GIT_DIR` encontrado a partir do repositório principal, nunca o arquivo `.git` da cópia (que o agente pode reescrever). A remoção só apaga diretamente pastas dentro de `<dados>/worktrees`.

## API

| Método e caminho                           | Corpo                         | Resposta                                       |
| ------------------------------------------ | ----------------------------- | ---------------------------------------------- |
| `GET /api/sessions/:id/worktree`           |                               | `WorktreeStatus`                               |
| `POST /api/sessions/:id/worktree`          | `{}`                          | 201 `{ session, status }`                      |
| `GET /api/sessions/:id/worktree/diff?path` |                               | `{ path, diff, truncated }`                    |
| `POST /api/sessions/:id/worktree/apply`    | `{ "confirm": true }`         | `{ commit, previous, branch, status }`         |
| `DELETE /api/sessions/:id/worktree`        | `{ "deleteBranch"?: boolean }` | `{ removed, branchDeleted, branch, session }` |

404 para conversa inexistente ou sem cópia; 409 para conversa avulsa, pasta que não é raiz de repositório, cópia já ligada e os bloqueios acima; 410 no diff quando a pasta da cópia sumiu. Validação com zod.

## Limites

- Só para a raiz de um repositório; projetos numa subpasta e conversas avulsas não têm cópia.
- Submódulos não são inicializados na cópia. Arquivos ignorados (`node_modules`, `.env`) não são copiados: o agente começa sem eles.
- Arquivos com drivers de merge próprios conflitam em vez de rodar o driver; o merge é desfeito e o usuário aplica o branch à mão.
- Dentro do sandbox, o agente edita os arquivos da cópia, mas comandos git que gravam (`add`, `commit`, `branch`) falham: o índice, os objetos e as refs da cópia ficam no `.git` do projeto, fora da pasta gravável. O commit é feito pelo Adelic no **Aplicar no projeto**.
- Branches da cópia (`adelic/…`) ficam no repositório até serem apagados pelo descarte ou pelo usuário.
