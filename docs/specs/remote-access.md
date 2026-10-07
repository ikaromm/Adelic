# Acesso remoto (opcional)

Por padrão, o Adelic escuta só em `127.0.0.1`, e quem usa este computador não faz login. Há duas formas opcionais de abri-lo de outro dispositivo, ambas com **usuário e senha**:

- **Tailnet:** pelo IP Tailscale do computador (`ADELIC_REMOTE_BIND`) ou por `tailscale serve`. Só alcança os seus dispositivos.
- **Internet:** pelo **Tailscale Funnel**, em `https://<máquina>.<tailnet>.ts.net/`, a partir de qualquer lugar.

## Como cada requisição é classificada

A classificação acontece antes de qualquer rota (`classifyRequest` em `server/http/auth.ts`). Na dúvida, a requisição é tratada como internet.

| Origem                                                                                                                           | Tipo       | Login               |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------- |
| Socket de loopback em `127.0.0.1:4317`, sem cabeçalhos de proxy                                                                  | `local`    | não                 |
| Listener `ADELIC_REMOTE_BIND` (sem cabeçalhos de proxy)                                                                          | `tailnet`  | sim (ou token)      |
| Loopback com `Tailscale-User-Login` (`tailscale serve`) e sem marca de Funnel                                                    | `tailnet`  | sim (ou token)      |
| Listener do Funnel (`127.0.0.1:ADELIC_FUNNEL_PORT`), com qualquer cabeçalho                                                      | `internet` | sim, só usuário     |
| Loopback com `Tailscale-Funnel-Request`                                                                                          | `internet` | sim, só usuário     |
| Loopback com qualquer outro cabeçalho de proxy (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Via`…), ou qualquer outro endereço   | `internet` | sim, só usuário     |

O sinal mais forte é a **porta**: o Funnel aponta para um listener próprio, e tudo o que chega nele é internet. Os cabeçalhos são uma segunda linha de defesa, com base no que o tailscaled 1.102 envia: no Funnel, `Tailscale-Funnel-Request: ?1` e `X-Forwarded-For`, sem identidade; no `serve`, `Tailscale-User-Login`. O tailscaled remove esses cabeçalhos quando é o cliente que os envia. O endereço encaminhado só é usado quando o socket é de loopback e o pedido veio do Funnel ou do `serve`.

## Conta

Só há uma conta, a do dono. Ela só pode ser criada ou trocada **neste computador**, nunca por um acesso remoto:

- **Configurações › Acesso remoto › Criar conta**, ou
- `npm run remote-user -- set <usuário>`, que pede a senha duas vezes sem mostrá-la. Os comandos `status`, `revoke-sessions` e `delete` também existem. Funciona com o Adelic aberto.

Regras: o usuário tem de 3 a 64 caracteres (`a-z`, `0-9`, `.`, `_`, `-`). A senha tem pelo menos 12 caracteres e não pode ser igual ao usuário; a tela mostra dicas de força. A senha é guardada com scrypt (N=2^15, r=8, p=1, sal de 16 bytes, chave de 64 bytes), e os parâmetros ficam junto do hash. **Trocar a senha encerra todas as sessões.**

## Sessões e login

- O cookie `adelic_session` guarda um id aleatório de 32 bytes, e o banco guarda só o SHA-256 dele. O cookie é `HttpOnly; SameSite=Strict; Path=/`, e também `Secure` quando o TLS termina no tailscaled (Funnel ou `serve`).
- A sessão expira após 7 dias sem uso e, no máximo, 30 dias depois do login. **Sair** apaga a sessão no servidor.
- Configurações lista as sessões ativas, com dispositivo, tipo, IP e último uso, e oferece **Encerrar** e **Encerrar todas**. Fluxos de eventos de uma sessão encerrada são fechados.
- Erros de login usam uma mensagem única: "Usuário ou senha incorretos".
- Limites: são 5 falhas por minuto por endereço (o encaminhado, no Funnel), com 429 depois disso. Além de 20 falhas em 10 minutos no total, cada tentativa espera um atraso que dobra até 30 s. A conta nunca é bloqueada de vez. **Últimos acessos** mostra os 200 logins mais recentes, com sucesso ou falha, IP e dispositivo.
- Alterações autenticadas por cookie exigem a mesma origem e `application/json` (CSRF).

## Funnel

**Configurações › Acesso remoto** mostra o estado do Tailscale: se está instalado e conectado, o nome MagicDNS e se HTTPS e Funnel estão liberados. Também mostra o botão **Publicar na internet**, que só fica ativo quando a conta existe e pede confirmação antes. O Funnel nunca liga sozinho.

Comandos executados (com `execFile`, tempo limite e sem shell):

```bash
tailscale funnel --bg --yes --https=443 --set-path=/ http://127.0.0.1:4319   # Publicar
tailscale funnel --yes --https=443 --set-path=/ off                          # Desligar
tailscale status --json; tailscale funnel status --json                      # estado
```

- A porta local vem de `ADELIC_FUNNEL_PORT` (padrão `4319`, sempre em `127.0.0.1`). O listener só abre quando o Funnel é pedido.
- Se `https://<máquina>/` já publicar outro destino, o Adelic não o substitui.
- O Adelic guarda só `funnel.wanted` e a porta. Ao iniciar, reaplica o Funnel (operação idempotente) apenas se ele estava ligado **e** a conta ainda existe. Apagar a conta desliga o Funnel.

O que a tailnet precisa permitir (o card aponta o que falta, com link):

1. MagicDNS e **HTTPS Certificates** em [DNS](https://login.tailscale.com/admin/dns).
2. O atributo `funnel` para este dispositivo em `nodeAttrs`, no [arquivo de acesso](https://login.tailscale.com/admin/acls/file), com a porta 443 liberada (padrão: 443, 8443 e 10000).
3. Seu usuário pode alterar o Tailscale sem sudo: `sudo tailscale set --operator=$USER`, uma vez só.

## O que fica bloqueado pela internet

Mesmo com login válido, estas operações recebem `403`:

- Terminal do projeto, sempre, mesmo com **Permitir terminal pelo acesso remoto** ligado (essa opção vale só para a tailnet).
- Alterações em servidores MCP, automações (incluindo o interruptor geral), verificações e bloqueios do projeto, e `git push`.
- Criar, trocar ou apagar a conta, ligar ou desligar o Funnel, ver o estado do Tailscale e mudar as opções de acesso remoto. A tailnet também não pode fazer isso: só este computador pode. Encerrar sessões continua possível de qualquer sessão.
- O token `ADELIC_REMOTE_TOKEN` (`Bearer` ou login por token).

As aprovações continuam funcionando pela internet. Com **Pela internet, exigir aprovação manual para comandos** ligado (padrão), cada execução iniciada de uma sessão pela internet usa `approvalMode: 'manual'`. Isso vale para mensagens, fila, editar e reenviar, tentar de novo, tarefas de plano aprovado e correção automática; a configuração global não muda.

## Cabeçalhos

Todas as respostas levam `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` e a CSP do app com `frame-ancestors 'none'`; o preview segue em `frame-src`. Quando o TLS termina no tailscaled, elas levam também `Strict-Transport-Security: max-age=31536000`.

## Migração do token

O `ADELIC_REMOTE_BIND` e o `ADELIC_REMOTE_TOKEN` (32+ caracteres) continuam funcionando na tailnet. Agora o login por token cria uma sessão aleatória, e o cookie deixa de conter o próprio token; os cookies antigos deixam de valer. Quando há conta, a tela de login pede usuário e senha, e o token fica como alternativa só na tailnet. Para migrar, crie a conta e, quando quiser, remova o `ADELIC_REMOTE_TOKEN`. O `ADELIC_REMOTE_BIND` exige um token, então, para usar só a conta, prefira `tailscale serve` ou o Funnel. Os dados ficam na migração 12 do SQLite: `remote_users`, `remote_sessions` e `remote_logins`.

## Modelo de ameaça e limites

- **Quem entra controla os agentes:** com usuário e senha, alguém lê e altera arquivos e executa comandos por meio dos agentes, dentro das permissões configuradas. As restrições da internet reduzem o alcance, mas não substituem uma senha forte e exclusiva.
- **Sem segundo fator:** não há 2FA nem vários usuários ou papéis. Os limites de tentativa atrasam a adivinhação, mas não a impedem para sempre.
- **Proxy próprio:** um proxy reverso seu, como nginx ou Caddy, é tratado como internet: não há modo "proxy confiável".
- **HTTP na tailnet:** o listener `ADELIC_REMOTE_BIND` usa HTTP simples. O tráfego é cifrado pela Tailscale, mas o navegador não considera isso um contexto seguro (sem `crypto.randomUUID`, área de transferência ou microfone; a interface funciona sem eles). Para HTTPS na tailnet, use `tailscale serve`.
- **Desktop:** o app desktop herda as variáveis do ambiente em que é aberto.
- **Desligar:** se o Adelic fechar, o Tailscale mantém o Funnel apontando para a porta, que deixa de responder. Clique em **Desligar** para remover a publicação.

## Validação

- `tests/remote-access.test.ts` cobre:
  - a matriz de classificação (endereço e porta do socket × cabeçalhos), em que a porta do Funnel é sempre internet;
  - scrypt, a política de senha, o hash da sessão em repouso e a expiração por inatividade e absoluta;
  - revogação, inclusive pela troca de senha, e os atributos do cookie;
  - os limites por IP encaminhado e global, a recusa do `Bearer` pela internet e as rotas bloqueadas pela internet e pela tailnet;
  - a aprovação manual forçada, os cabeçalhos, o CLI com entrada injetada e os comandos do Funnel com um `tailscale` falso (nunca o real).
  - O caminho da tailnet usa `127.0.0.2`; o da internet, um listener de Funnel numa porta efêmera.
- `tests/e2e/remote-login.spec.ts` cobre a criação da conta e a publicação com confirmação neste computador. Pela porta de Funnel do servidor E2E, cobre o login, a senha errada, a lista de sessões e a saída a 360 px, além de encerrar as sessões pelo computador.
