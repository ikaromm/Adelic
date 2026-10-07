# Verificações e bloqueios por projeto

2026-10-07. Pedido: rodar verificações (testes, typecheck) depois que um agente altera o projeto e bloquear comandos por projeto, sem afrouxar o sandbox nem a política de aprovações.

## Onde fica a configuração

Só no banco do Adelic, digitada pelo usuário em Configurações › **Verificações e bloqueios** (aparece com um projeto selecionado). Nunca é lida de arquivos do repositório: o agente escreve na pasta do projeto, e um comando lido dali seria execução arbitrária.

Tabela `project_hooks(project_id PRIMARY KEY, data JSON)` (migração 9, `ON DELETE CASCADE`). Fica fora de `projects.data` para que um PATCH do projeto ou a exportação não carreguem nem sobrescrevam comandos executáveis.

```json
{
  "afterEdit": [{ "name": "testes", "command": "npm test", "timeoutSec": 120, "enabled": true }],
  "blockedCommands": ["git push*", "rm -rf *"],
  "autoFix": false
}
```

Limites: até 5 verificações; nome até 60 caracteres; comando até 500; tempo limite de 5 a 600 s (padrão 120); até 30 padrões bloqueados de até 200 caracteres, sem repetição.

## Verificações depois de alterações

Rodam quando uma execução de um projeto termina **concluída** e o checkpoint mostra arquivos alterados (`run.checkpoint.files`; ver [checkpoints](checkpoints.md)). Sem checkpoint (pasta fora do git, sandbox somente leitura, conversa avulsa), falha, cancelamento ou nenhuma alteração: nada roda. Rodam em ordem, só as ativas, e não seguram a próxima mensagem.

Cada verificação vira um evento `check` da execução: "Verificação: testes passou (12 s)", "… falhou (código 1)", "… excedeu o tempo limite", com a saída (últimos 64 KB de stdout+stderr) num item expansível. A saída parcial é salva a cada 2 s.

**Onde roda:** `/bin/sh -c <comando>` dentro do mesmo bubblewrap dos agentes (`server/providers/sandbox.ts`): `/` somente leitura, a pasta do projeto gravável (perfil workspace-write, para caches de testes), `/tmp` privado, novo PID namespace, `--die-with-parent`, e **sem rede** (`--unshare-net`, só para verificações). cwd = pasta do projeto. Ambiente reduzido a PATH, HOME, USER, LANG/LC_*, TZ, mais `CI=1`, `TMPDIR=/tmp`, `NO_COLOR=1`: tokens do Adelic e variáveis do servidor não passam. Só o texto digitado pelo usuário vai para o shell; nada é interpolado. Sem bubblewrap, a verificação falha com o motivo e não roda fora do sandbox.

**Parar:** tempo limite, cancelamento e encerramento do Adelic matam o grupo de processos (SIGTERM, depois SIGKILL). Uma nova execução que pode escrever no projeto **cancela** as verificações em andamento, com a nota "cancelada: nova execução neste projeto"; desfazer alterações também cancela.

## Corrigir automaticamente

Desligado por padrão. Se alguma verificação falhar (ou exceder o tempo), o Adelic inicia **uma** execução na mesma conversa, com a mensagem "Corrigir automaticamente: a verificação “testes” falhou" e, para o agente, a saída das falhas (até 8 KB no total, marcada como dado não confiável). As verificações dessa execução rodam de novo, mas nunca iniciam outra correção: no máximo uma por mensagem do usuário. Execuções de tarefas de plano não iniciam correção. Se a conversa estiver ocupada, a nota "Correção automática não iniciada" fica na execução.

## Comandos bloqueados

Padrões com `*` (qualquer texto, inclusive vazio); o resto é literal, então não há expressão regular nem injeção. O padrão casa com o comando inteiro, depois de juntar espaços, tabs e quebras de linha em um espaço. O texto também é comparado com o script de um `bash -lc '…'` e com cada parte separada por `;`, `&&`, `||`, `|`, `&` e quebra de linha (`ls | rm -rf build` casa com `rm -rf *`).

Quando um pedido de aprovação traz um comando que casa, ele é **negado sem perguntar**, inclusive no modo Automático seguro, e a atividade mostra "Comando bloqueado pelas regras do projeto: <cmd>". No Codex a negação acontece antes da classificação automática (a resposta é `decline`). Nos demais, o orquestrador nega o pedido pendente ao recebê-lo. Aprovar pela tela um pedido que passou a casar com uma regra salva depois responde 409 e nega o pedido. As regras só acrescentam restrições: nunca aprovam nada.

Limite: só veem o que o runtime manda no pedido de aprovação. Comandos que o runtime executa sem pedir (confiança nativa do Codex, patches internos; ver [aprovações](safe-command-approvals.md)) não passam por aqui. Do Kiro, o comando vem de `toolCall.rawInput.command` quando presente; o Claude não tem aprovação remota. Conversas avulsas não têm regras de projeto.

## API

- `GET /api/projects/:id/hooks` → configuração (vazia se nunca salva).
- `PUT /api/projects/:id/hooks` → substitui tudo (zod; campos ausentes ficam vazios/desligados; 400 com a mensagem do campo).
- `POST /api/projects/:id/hooks/test` com `{ "index": n }` → roda uma verificação agora (mesmo sandbox, inclusive desativadas) e devolve `{ name, status, exitCode, durationMs, output, truncated? }`. 409 enquanto uma execução pode escrever no projeto ou outras verificações rodam; 404 sem verificação nesse índice.
