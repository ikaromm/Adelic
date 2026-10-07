# Terminal e preview local

## Uso

- O botão **Terminal e preview do projeto** fica no topo quando há um projeto em contexto: numa conversa vinculada ou com o projeto selecionado na tela inicial. Conversas avulsas não têm terminal. O painel abre embaixo da conversa, com as abas **Terminal** e **Preview**.
- **Terminal:** cada comando vai para `/bin/sh -c <comando>` na pasta do projeto. A saída (stdout e stderr, este em laranja) chega ao vivo. Ao terminar, aparecem o código de saída e a duração. **Parar** encerra o comando e tudo o que ele iniciou. O tempo limite padrão é 10 min, e o seletor oferece de 1 a 60 min.
- O painel avisa: "Executa no sandbox do Adelic com as mesmas permissões dos agentes". Os comandos e a saída **não são enviados a nenhum modelo**.
- **Sem PTY nem entrada:** o stdin é fechado, então programas interativos recebem fim de arquivo. Use opções não interativas (`--yes`, `CI=1`, `--no-watch`). `TERM=dumb` e `NO_COLOR=1` são definidos; sequências ANSI restantes são ignoradas na detecção de endereços.
- **Histórico:** ↑ e ↓ percorrem os últimos 50 comandos do projeto, guardados no `localStorage` do navegador. Só o texto do comando é guardado, nunca a saída.
- **Preview:** um campo de endereço aceita somente servidores locais: `http(s)://localhost`, `127.0.0.1` ou `[::1]`, em qualquer porta. A página abre num `<iframe sandbox="allow-scripts allow-forms allow-same-origin">`, com botões **Recarregar** e **Abrir no navegador**. Quando a saída de um comando mostra um endereço de servidor de desenvolvimento (por exemplo `Local: http://localhost:5173/`, ou `0.0.0.0`, oferecido como `127.0.0.1`), aparece **Abrir preview**.

## Modelo de segurança

- **Mesmo sandbox dos agentes:** o comando é envolvido pelo mesmo construtor de bubblewrap (`server/providers/sandbox.ts`), com o `sandbox` das configurações lido no início de cada comando. `/` fica somente leitura, `/tmp` é um tmpfs próprio, e o PID namespace é isolado. Em **Somente leitura**, nada pode ser gravado no projeto. Em **Escrita no projeto**, só a pasta do projeto é gravável. A rede segue a política dos agentes, que hoje não a restringe. Sem bubblewrap, o comando falha com a mensagem do sandbox e não roda sem isolamento.
- **Ambiente:** `ADELIC_REMOTE_TOKEN`, `ADELIC_MEMORY_TOKEN`, `BASH_ENV`, `ENV` e funções exportadas `BASH_FUNC_*` não passam para o comando. O restante do ambiente do Adelic é herdado, como nos agentes.
- **Parar e tempo limite:** o bubblewrap informa (`--info-fd`) o PID do processo inicial do sandbox. Parar mata esse processo, e o kernel encerra todo o PID namespace. Depois, o grupo de processos do lançador é encerrado (SIGTERM, depois SIGKILL). No encerramento do Adelic, todos os comandos são parados.
- **Acesso remoto:** requisições que não são locais (tailnet ou internet, classificadas em `server/http/auth.ts`; veja [acesso remoto](remote-access.md)) recebem `403` em todas as rotas do terminal. Pela internet (Tailscale Funnel) a recusa é permanente. `GET /api/projects/:id/terminal` responde `enabled: false` sem listar comandos nem saída. A opção **Permitir terminal pelo acesso remoto** (`terminalRemote`, desligada por padrão) libera o terminal para a tailnet e só pode ser alterada no próprio computador: a mudança feita remotamente recebe `403`. A autenticação e a proteção de Host/Origin não mudam.
- **Preview:** o endereço é conferido pelo mesmo parser de URL do navegador (`shared/terminal.ts`). São recusados outros hosts (`127.0.0.1.evil.com`), usuário ou senha no endereço (`evil.com@localhost`), esquemas que não sejam http(s) e a porta do próprio Adelic. No desktop, a política de navegação do Electron (`desktop/policy.ts`) aplica a mesma regra a toda navegação e redirecionamento de subframes: o frame não sai do loopback. A página do preview tem outra origem: a proteção de Origin recusa as alterações que ela tentar na API do Adelic, e a política de mesma origem do navegador impede que ela leia as respostas.
- **CSP:** todas as respostas levam `Content-Security-Policy: frame-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; frame-ancestors 'none'`, sem curingas de host. A CSP não aceita IPv6 literal como host, então `[::1]` não abre no frame: ele é aceito e oferecido só em **Abrir no navegador**. Os anexos mantêm a CSP própria, mais restrita.
- **No acesso remoto,** `localhost` e `127.0.0.1` apontam para o computador que roda o Adelic. O preview não carrega no outro dispositivo, e o painel mostra esse aviso.

## Limites

- Até 3 comandos em execução por projeto (`409` no quarto).
- Últimos 256 KB de saída por comando, contando stdout e stderr juntos. A saída mais antiga é descartada e o painel avisa. Os eventos ao vivo seguem o mesmo limite.
- Comando com até 8000 caracteres. Os comandos ficam só na memória do servidor, os últimos 20 encerrados por projeto: reiniciar o Adelic apaga a lista. Nada vai para o banco, e não há migração.

## API

- `POST /api/projects/:id/terminal` com `{ command, timeoutSec? }` (`timeoutSec` de 60 a 3600, padrão 600) responde `202 { id, command }`, `400` para corpo inválido, `404` para projeto desconhecido e `409` com 3 em execução.
- `GET /api/projects/:id/terminal` devolve `{ enabled, remote, reason?, sandbox, maxRunning, commands }`.
- `GET /api/projects/:id/terminal/events` (SSE) envia `snapshot`, depois `command` (início e fim) e `output` (`{ id, chunks: [{ stream, text }], truncated? }`).
- `GET /api/terminal/:id` devolve o estado e a saída guardada: `status` (`running`, `exited`, `stopped`, `timeout`, `failed`), `exitCode`, `durationMs` e `output`.
- `POST /api/terminal/:id/stop` com corpo `{}` responde depois que o comando terminou.

## Validação

- `tests/terminal.test.ts`, com bubblewrap real quando ele consegue criar namespaces (senão esses casos são pulados), cobre: `echo`, `false`, parar `sleep` e o tempo limite, sem processos sobrando; escrita só no projeto em workspace-write e nenhuma em read-only. Cobre também o limite de saída, o limite de 3 comandos, a recusa remota (pelo endereço `127.0.0.2`), a validação de URLs, a política de subframes do desktop, a CSP e a detecção de endereços.
- `tests/e2e/terminal.spec.ts` cobre `echo olá`, parar `sleep 30`, as mensagens de validação do preview e a tela de 360px. O servidor E2E usa o bubblewrap real quando ele funciona no ambiente. Senão (alguns contêineres de CI), injeta um executor sem sandbox, na pasta do projeto, só para cobrir a interface.
