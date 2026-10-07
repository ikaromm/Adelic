# Menções de arquivos com `@`

## Uso

- Digite `@` no início da mensagem ou depois de um espaço para ver os arquivos do projeto da conversa. A lista é filtrada pelo que vem depois do `@` (`@src/app` encontra `src/App.tsx`). Setas movem a seleção, **Enter** ou **Tab** inserem `@caminho `, **Esc** fecha até o texto mudar, e o mouse também funciona. Caminhos com espaço entram entre aspas: `@"notas da equipe.md" `.
- A lista segue o mesmo padrão ARIA de combobox da lista de comandos (foco no campo, `aria-controls` e `aria-activedescendant`). As duas listas nunca abrem ao mesmo tempo: com `/` no início, vale a de comandos.
- Sem opções na lista, Enter envia a mensagem como foi digitada.
- Conversas sem projeto mostram "Escolha um projeto para mencionar arquivos". A pasta própria da conversa avulsa não é listada.
- Na conversa, as menções aparecem como chips discretos na mensagem do usuário. O texto guardado não muda.

## O que o agente recebe

- O servidor reconhece `@caminho` e `@"caminho"` no texto digitado, no início ou depois de um espaço. Endereços de e-mail (`a@b.com`), código entre crases e blocos de código não contam. A pontuação no fim (`@a.ts,`) é descartada, e menções repetidas contam uma vez só.
- Isso acontece em `Orchestrator.start`, então vale para envio normal, fila, Enviar agora, Tentar de novo, comandos salvos (as menções vêm do texto digitado, não do modelo) e execuções do modo de planejamento. Orientar um turno em andamento envia só o texto.
- Cada arquivo mencionado e aceito entra no **pedido** (e não na mensagem guardada) como `[Arquivo mencionado: caminho]`, seguido de um bloco cercado. É o mesmo formato dos anexos de texto: a cerca é maior que qualquer sequência de crases do arquivo. Em execuções coordenadas, o arquivo vai para o planejador e para os executores, como os anexos.
- A atividade registra "Arquivos mencionados incluídos: …" e, para cada menção recusada, "Menção ignorada: caminho (motivo)". Uma menção recusada continua como texto comum.

## Limites e segurança

- Até 5 arquivos por mensagem, cada um com até 512 KB e até 1 MB no total. Só arquivos comuns em UTF-8 sem bytes nulos são aceitos.
- O caminho é relativo à pasta do projeto. Caminhos absolutos, `~`, letras de unidade, `\` e segmentos `..` são recusados sem acessar o disco. O caminho real, com links resolvidos, precisa ficar dentro do projeto. O arquivo é aberto com `O_NOFOLLOW`, e o descritor aberto é conferido de novo (`/proc/self/fd`), então um link trocado depois da verificação não é seguido. Links simbólicos que apontam para dentro do projeto funcionam.
- Motivos registrados: fora do projeto, arquivo não encontrado, não é um arquivo, arquivo ilegível, arquivo binário, não é texto UTF-8, maior que 512 KB, limite total de 1 MB por mensagem, limite de 5 arquivos por mensagem, pasta do projeto indisponível.

## API

`GET /api/projects/:id/files?query=&limit=50` devolve `{ files: string[], truncated: boolean }`, com caminhos relativos separados por `/`.

- `query` pode ter até 1024 caracteres; `limit` vai de 1 a 200 (padrão 50). Valores inválidos retornam `400`, projeto desconhecido `404` e pasta ilegível `409`.
- Em repositório git, a lista vem de `git ls-files -z --cached --others --exclude-standard`, executado na pasta do projeto com o mesmo `git` endurecido dos checkpoints: sem shell, com tempo limite, `GIT_TERMINAL_PROMPT=0`, sem hooks, fsmonitor nem variáveis `GIT_*` herdadas. Ela inclui os arquivos rastreados e os novos não ignorados.
- Fora do git, a pasta é percorrida até 20.000 entradas e 12 níveis. A busca pula `node_modules`, `dist`, `build` e pastas ocultas, e não segue nem lista links simbólicos.
- `truncated` é `true` quando a listagem bateu num limite ou quando há mais resultados que `limit`.
- A listagem fica em cache por projeto durante cerca de 10 s. A ordem é: prefixo do nome do arquivo, depois trecho do nome, trecho do caminho e, por fim, letras do caminho na ordem digitada. Empates ficam com o caminho mais curto e depois com a ordem da listagem.

## O que não foi feito

- Pastas, imagens e outros binários não são aceitos como menção.
- O conteúdo é lido no início da execução. Uma mensagem na fila lê o arquivo quando começa, não quando entrou na fila.
