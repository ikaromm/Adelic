# Catálogo de servidores MCP por projeto

Servidores MCP locais (stdio) que o usuário cadastra no Adelic e liga **por projeto**. É opt-in e desligado por padrão: nada vem pré-cadastrado, todo projeto começa sem servidores e conversas avulsas nunca recebem MCP. Servidores remotos (HTTP/SSE, `url`, cabeçalhos, tokens) não são aceitos nesta versão; a API recusa esses campos.

> Servidores MCP executam programas com o seu usuário dentro do sandbox do agente.

## Catálogo e API

Migração 11: `mcp_servers(id, name UNIQUE, data)`. Cada entrada tem `name` (1 a 48 caracteres `[a-z0-9_-]`, começando por letra ou número), `description` (até 300), `transport: 'stdio'`, `command`, `args` (até 20, cada um até 500 caracteres), `env` (até 20) e `tools` opcional (lista de ferramentas permitidas, até 100).

- **Comando**: um caminho absoluto executável ou um nome procurado com `which` ao salvar. O caminho absoluto resolvido é o que fica guardado. Caminhos relativos são recusados.
- **Ambiente**: prefira `from: 'adelic-env'`, que repassa só o **nome** de uma variável do ambiente do próprio Adelic; o valor é lido a cada execução, e variáveis ausentes são omitidas e indicadas no diagnóstico. `from: 'literal'` guarda um valor fixo que é **somente escrita**: GET, PATCH, POST e `/api/export` devolvem só `set: true`, e a tela mostra `••••`. Num PATCH, um literal enviado sem `value` mantém o valor guardado.
- Valores literais e repassados chegam ao agente pelo corpo JSON-RPC via stdin, nunca por argv.

| Método e caminho              | Corpo                                                      | Efeito                                                             |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/mcp-servers`        | —                                                          | `{ servers }`, sem valores literais                                |
| `POST /api/mcp-servers`       | `{ name, command, description?, args?, env?, tools? }`     | 201; 409 nome repetido; 400 comando não encontrado ou campo remoto |
| `PATCH /api/mcp-servers/:id`  | campos parciais; `tools: null` remove a lista              | Edita                                                              |
| `DELETE /api/mcp-servers/:id` | `{}`                                                       | 204; também tira a entrada de todos os projetos                    |
| `GET /api/projects/:id/mcp`   | —                                                          | Diagnóstico: servidores ligados e o que cada agente usaria         |
| `PUT /api/projects/:id/mcp`   | `{ enabled: string[] }` (até 20 ids do catálogo)           | Grava `Project.enabledMcp`; 400 para id desconhecido               |

Em Configurações, o cartão **Servidores MCP** tem o aviso acima, o CRUD com as mesmas validações da API, uma chave por servidor para o projeto selecionado e o diagnóstico por agente.

## Quando um servidor entra numa execução

O orquestrador só preenche `RunInput.mcpServers` quando a conversa está vinculada a um projeto que ligou entradas e a execução tem ferramentas. Planejamento (somente leitura), compactação, resumos de passagem e conversas avulsas não recebem MCP. Executores delegados com ferramentas recebem os servidores do mesmo projeto.

## Garantias fail-closed

**Codex** (app-server 0.160):

- Os servidores aprovados vão em `thread/start` `config.mcp_servers`, só naquela thread, com `default_tools_approval_mode: 'prompt'`, `enabled_tools` quando há lista permitida e `env_vars` para os nomes repassados. Nada entra em `-c` nem em argv.
- `config/read` continua sendo verificado antes da thread. Qualquer MCP **ativo** na configuração efetiva do Codex (`~/.codex/config.toml`, `.codex/config.toml` do projeto) bloqueia a execução, com ou sem servidores do Adelic. Também bloqueia uma entrada local, mesmo desligada, com o nome de um servidor aprovado, porque os campos dela se misturariam aos do Adelic. Sem servidores ligados, o comportamento anterior continua: qualquer MCP ativo bloqueia.
- Depois de `thread/start`, `mcpServerStatus/list` da thread precisa listar só servidores aprovados, além de entradas locais desligadas. Antes de qualquer turno, a execução é bloqueada se aparecer outro servidor, um servidor vindo de plugin, uma ferramenta fora da lista ou uma resposta ilegível.
- Chamadas de ferramenta MCP (`mcpServer/elicitation/request`) viram aprovação **manual**, uma por chamada, mesmo no modo de aprovação segura. Pedidos de servidores não aprovados, do modo `url` ou sem turno ativo são recusados.

**Kiro** (ACP, 2.23):

- As entradas vão em `session/new` `mcpServers` como `[{ name, command, args, env: [{ name, value }] }]`. O Kiro roda com um `KIRO_HOME` temporário e um agente sem `mcpServers` e com `includeMcpJson: false`.
- Depois de `session/new`, o Adelic consulta `_kiro.dev/commands/execute` `mcp`. Se aparecer um servidor fora da lista ou não houver resposta, a execução é bloqueada antes do prompt. Sem servidores ligados, o comportamento é o anterior: lista vazia e nenhuma consulta.
- **Limitação**: o Kiro 2.23 não aplica a lista de ferramentas do agente a servidores recebidos por ACP. Uma entrada com `tools` bloqueia execuções Kiro em vez de liberar todas as ferramentas. A verificação depende do relato do próprio Kiro, que não faz parte do ACP publicado. Se uma versão futura omitir algo nesse relato, o Adelic não tem como perceber.
- As permissões continuam manuais (`session/request_permission`), como para as outras ferramentas do Kiro.

**Claude e OpenCode**: não usam o catálogo. O Claude continua com `--strict-mcp-config` e nenhum servidor.

**Sandbox**: os servidores MCP são iniciados pelo agente dentro do bubblewrap e herdam o mesmo isolamento. Como `/` já é montado somente leitura, só um comando sob `/tmp` (escondido pelo tmpfs) precisa de montagem: a pasta do comando (e a do alvo real, se for link) entra somente leitura pelo mecanismo existente. `/tmp` e `$HOME` inteiros nunca são montados, e um comando direto em `/tmp` é recusado. Um comando que sumiu bloqueia a execução antes de o agente iniciar.

## Verificado e assumido

Verificado neste computador com binários reais e servidores MCP de teste:

- Codex 0.160: `thread/start` com `config.mcp_servers` conecta o servidor só naquela thread, e `config/read` não o mostra. `enabled_tools` filtra as ferramentas, `env` entrega literais e `env_vars` repassa nomes. `mcpServerStatus/list` com `threadId` lista servidores da thread e entradas locais desligadas (`runtimeStatus: 'disabled'`).
- Kiro 2.23: `session/new` com `mcpServers` inicia o servidor e emite `_kiro.dev/mcp/server_initialized`. O comando `mcp` lista os servidores da sessão e o comando `tools` mostra as ferramentas MCP como `requires-approval`. A lista `tools` do agente não restringe servidores recebidos por ACP.

Coberto por testes com servidores simulados e bubblewrap real: só os servidores ligados aparecem em `thread/start`, nada em argv, servidores estranhos são recusados em `config/read` e na thread, sem servidores ligados tudo é bloqueado como antes, o payload do Kiro está correto, as montagens do sandbox funcionam e conversas avulsas nunca recebem MCP.

Assumido, sem execução real de ponta a ponta com modelo: que o Codex envia `mcpServer/elicitation/request` em toda chamada de ferramenta com `default_tools_approval_mode: 'prompt'`, e que a resposta `accept` vale só para aquela chamada.
