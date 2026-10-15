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
  - **Descartar worktree** (confirmação): `git worktree remove --force` e apaga o branch só se ele não tiver commits fora do projeto ou se o usuário marcar "Apagar o branch também". Se o usuário escolher manter o branch, a conversa volta imediatamente ao projeto e pode criar outra cópia sem apagar o branch retido.
- Apagar a conversa remove a cópia; o branch fica, a menos que já esteja no projeto. Ao iniciar, registros ativos cuja pasta sumiu são removidos; um registro de limpeza pendente após remoção da pasta continua persistido (não é um `cwd` ativo) até que branch/prova próprios possam ser tratados. `git worktree prune` limpa metadados do checkout.
- Com a cópia ligada, a conversa não muda de projeto (409); descarte antes.

## Garantias

- **A pasta principal só é alterada pelo "Aplicar no projeto"**, e só quando ela está sem alterações (`git status` vazio, inclusive arquivos não rastreados), em um branch (não em HEAD destacado) e sem merge, rebase ou cherry-pick em andamento. Senão: 409 com o motivo. Nada é guardado no stash, resetado ou trocado de branch.
- Se o merge der conflito, o Adelic roda `git merge --abort` e devolve 409 com a lista de arquivos; a pasta principal fica como estava. O commit na cópia permanece no branch.
- Se o branch cria um arquivo que existe na pasta principal como ignorado, o merge é recusado (o git o sobrescreveria sem avisar).
- Recusado (409) enquanto houver execução, plano ou outra operação da cópia na conversa, ou execução, desfazer ou outro "Aplicar" na pasta principal; novas execuções ali recebem 409 enquanto o merge roda.
- Todo comando usa o git endurecido de `server/checkpoints.ts` (`execFile` sem shell, timeout, `GIT_TERMINAL_PROMPT=0`, variáveis `GIT_*` herdadas descartadas). Além disso: hooks de todos os eventos desligados (`core.hooksPath=/dev/null` e `hook.<evento>.enabled=false`), filtros clean/smudge/process e drivers de merge do repositório anulados, `--no-verify`, sem autostash. O agente pode escrever na cópia, e o Adelic roda o git fora do sandbox.
- Os comandos na cópia usam o `GIT_DIR` encontrado a partir do repositório principal, nunca o arquivo `.git` da cópia (que o agente pode reescrever). A remoção só apaga diretamente pastas dentro de `<dados>/worktrees`.
- Toda worktree criada pelo Adelic (sessão e executor) recebe, no `AdminDir` Git criado, um marcador de continuidade com nonce aleatório vinculado à sua ref CAS. O registro só confirma propriedade quando criação e gravação do marcador terminaram. Para inspecionar ou remover um ocupante atual, o Adelic exige o marcador no `AdminDir` que o próprio Git registra para aquele caminho, além da branch/ref e do registro de checkout. Recriar o worktree na mesma branch e caminho gera um novo `AdminDir` sem o marcador antigo; coincidência de caminho, branch, commit, `AdminDir` ou histórico não basta. Ausência de marcador/prova (inclusive em registros legados) é incerteza, nunca autorização, e o conteúdo e recursos permanecem preservados para inspeção/recuperação. O descarte captura o OID autorizado antes de remover a pasta; uma releitura posterior apenas permite CAS se a ref continuar exatamente nessa versão. Retry pode limpar recursos próprios ainda presentes segundo inventário e pins persistidos, inclusive uma proofref própria remanescente após pasta e branch terem sido removidos. Checkouts alheios e operações Git em andamento continuam protegidos.

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
- No executor local isolado, recursos locais já preparados em `node_modules` do checkout principal verificado podem ser montados somente leitura na worktree, independentemente da linguagem ou da presença de `package.json`. A origem continua limitada ao diretório real dentro do checkout ou ao link gerenciado exato do Adelic; links para outras origens não são aceitos, e um `node_modules` já presente na worktree nunca é sombreado. Quando falta o destino no modo read-only, o sandbox monta uma raiz `/workspace` em tmpfs e liga separadamente suas entradas de primeiro nível e os recursos autorizados, sempre somente leitura; links simbólicos de primeiro nível são recriados pelo texto original dentro do namespace, sem seguir alvos no host. A raiz também é remontada somente leitura antes do comando; nenhum `node_modules` é criado na worktree real. Entradas especiais (por exemplo, FIFO e socket) na raiz bloqueiam essa preparação. O executor não instala recursos nem herda arquivos `.env`; falha da preparação bloqueia o comando.
- Arquivos com drivers de merge próprios conflitam em vez de rodar o driver; o merge é desfeito e o usuário aplica o branch à mão.
- Dentro do sandbox, o agente edita os arquivos da cópia, mas comandos git que gravam (`add`, `commit`, `branch`) falham: o índice, os objetos e as refs da cópia ficam no `.git` do projeto, fora da pasta gravável. O commit é feito pelo Adelic no **Aplicar no projeto**.
- Branches da cópia (`adelic/…`) ficam no repositório até serem apagados pelo descarte ou pelo usuário.
- O marcador de continuidade protege contra substituição/recriação acidental ou concorrente que não conhece o nonce da execução. Não é uma fronteira de isolamento entre atores no mesmo usuário: quem puder copiar o nonce ou editar metadados do `AdminDir`, refs, armazenamento do repositório ou base de dados do Adelic pode contornar essa proteção. O Adelic não tenta inferir origem de candidatos antigos sem marcador; nesses casos, preserva para recuperação manual. A remoção da branch continua sujeita a verificação de uso por checkouts/rebase/bisect e compare-and-delete do OID.
