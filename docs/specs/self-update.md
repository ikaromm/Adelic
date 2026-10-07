# Atualizar o Adelic

2026-10-07. Pedido: um botão "Atualizar Adelic" em Configurações › Diagnóstico, que nunca atualiza sozinho e se recusa em vez de arriscar o trabalho do usuário.

## Modos

O tipo de instalação é detectado em tempo de execução (`server/self-update.ts`, `detectInstall`):

- **Checkout git** (`npm start` / `npm run dev`): a pasta do processo é a raiz (`git rev-parse --show-toplevel`) de um repositório cujo `package.json` se chama `adelic`.
- **AppImage**: o backend roda dentro do Electron e `$APPIMAGE` está definido.
- **Outros** (build copiado, desktop fora de AppImage): mostra a versão e o link da release, sem botão de atualizar.

O cartão mostra versão, commit (checkout), tipo de instalação, **Verificar atualizações** e, quando possível, **Atualizar agora**. A verificação usa a rede só com "Verificar novas versões" ligado ou quando o usuário clica.

## Checkout git

**Canal de atualização** (`Settings.updateChannel`): `master` (estável, padrão) ou `develop` (prévia).

Verificar: `git fetch origin <canal>` e comparação de `HEAD` com `origin/<canal>`: commits atrás (contagem e os 10 últimos assuntos), à frente, árvore limpa e se o `package-lock.json` muda.

Atualizar só avança o branch (`git merge --ff-only`). Recusa, com o motivo:

- alterações em arquivos rastreados (arquivos não rastreados não impedem);
- commits locais à frente ou branch divergente;
- HEAD em outro branch: oferece **trocar para o canal** só com a árvore limpa, com um branch local que acompanhe `origin/<canal>` e quando isso também é um fast-forward;
- filtros clean/smudge definidos na configuração do repositório;
- qualquer execução, fila, plano em execução, desfazer, operação do painel Git, worktree ou verificação de projeto em andamento (`Orchestrator.updateBlock`). Durante a atualização, novas execuções e operações git recebem 409.

Passos: fetch → (troca de branch) → merge → `npm ci --no-audit --no-fund` se o lockfile mudou → `npm run build -- --outDir .adelic/update-build-…` (10 min cada) → troca da pasta `dist` por rename → reinício. O `dist` em uso só é trocado depois de um build bem-sucedido. Qualquer falha antes disso volta HEAD (e o branch, se houve troca) com `git reset --hard` para o commit inicial; isso é seguro porque a árvore estava limpa no início. Se o lockfile mudou, `npm ci` roda de novo na versão anterior. O servidor continua no código antigo.

O git roda pelo executor endurecido de `server/checkpoints.ts`: `execFile` sem shell, timeouts, `GIT_TERMINAL_PROMPT=0`, variáveis `GIT_*` descartadas, hooks desligados (`core.hooksPath=/dev/null` e `hook.<evento>.enabled=false`), fsmonitor desligado, `submodule.recurse=false`. O fetch também bloqueia os transportes `ext::` e `git://`, usa o `git-upload-pack` padrão, ignora askpass e helpers de credencial do repositório e usa SSH em `BatchMode`. O npm roda com o ambiente do usuário, sem `NODE_ENV` nem variáveis `npm_*` do `npm start` pai: é o build do próprio projeto.

## AppImage

Verificar: `releases/latest` do GitHub, ignorando rascunhos e pré-releases. Atualizar:

1. baixa `Adelic-<v>-linux-x86_64.AppImage.sha256` e o AppImage, só de `https://github.com/ikaromm/Adelic/releases/download/…`, com redirecionamentos apenas em https para `github.com`, `objects.githubusercontent.com` ou `release-assets.githubusercontent.com`; limite de 500 MB, gravado num arquivo temporário na mesma pasta de `$APPIMAGE`;
2. confere o SHA-256 com o `.sha256` da release e a assinatura ELF no início do arquivo;
3. `chmod 755`, guarda o atual como `Adelic.AppImage.previous` (hard link, ou cópia) e troca o arquivo por rename atômico;
4. reinicia.

Se `$APPIMAGE` ou sua pasta não aceitam escrita, o cartão explica e aponta para a página da release.

**O que é verificado:** o SHA-256 vem da mesma release, então protege contra download corrompido ou truncado, não contra uma release comprometida. A atestação de proveniência (`gh attestation verify`) não é conferida aqui; para isso, baixe pela página da release e verifique manualmente.

## Reinício

- **Checkout**: o servidor inicia uma cópia de si mesmo, desacoplada, com o mesmo comando (sob tsx, pelo `node_modules/.bin/tsx`), ambiente e pasta, mais `ADELIC_RESTART_WAIT=30000`. A cópia repete a abertura da trava da pasta de dados e das portas enquanto recebe `EADDRINUSE`, por até 30 s. O processo antigo fecha normalmente e sai. A saída do novo processo vai para `<pasta de dados>/self-update.log`.
- **AppImage**: o backend avisa o processo principal (`{ type: 'relaunch' }`), que encerra o backend como num fechamento normal e chama `app.relaunch({ execPath: $APPIMAGE })` e `app.exit(0)`.

A interface mostra as etapas e a saída (últimos 64 KB). Ao chegar em "Reiniciando…", consulta `/api/update/status` até outro `bootId` responder e recarrega a página.

## API

Somente pedidos feitos neste computador (loopback); pelo acesso remoto todas as rotas respondem 403 (`updateRequestAllowed` em `server/http/update.ts`).

- `GET /api/update/status` → `SelfUpdateStatus`.
- `POST /api/update/check` `{ channel? }` → `SelfUpdateStatus`.
- `POST /api/update/apply` `{ confirm: true, channel?, target? }` → 202 e `UpdateProgress`. `target` é o commit ou a versão mostrada na confirmação; se mudou, a atualização é recusada. 409 quando algo impede ou outra atualização está em andamento.
- `GET /api/update/progress` → `UpdateProgress`.

## Limites

- Nada é atualizado sem clique e confirmação; não há atualização em segundo plano.
- Falha depois do build (no reinício) não desfaz a atualização: o cartão pede para reiniciar à mão.
- Um `npm ci` que falha ao restaurar a versão anterior fica registrado na saída; rode `npm ci` manualmente.
- Sem `ADELIC_RESTART_WAIT`, como num início normal, porta ocupada falha na hora.
