# Acesso remoto (opcional)

Por padrão, o Adelic escuta somente em `127.0.0.1` e nada muda. O acesso a partir de outro dispositivo, por exemplo pela Tailscale, só é aberto quando as duas variáveis abaixo estão definidas:

```bash
ADELIC_REMOTE_BIND=100.x.y.z         # IP específico, por exemplo o IP Tailscale do computador
ADELIC_REMOTE_TOKEN=$(openssl rand -hex 32)
ADELIC_REMOTE_PORT=4318              # opcional
```

## Regras

- **Endereço:** precisa ser um IP específico. `0.0.0.0`, `::` e nomes de host são recusados, assim como um token com menos de 32 caracteres. Nesses casos o Adelic não inicia, em vez de abrir um acesso inseguro.
- **Servidor:** é o mesmo aplicativo, num segundo endereço. O `127.0.0.1` continua com a proteção de Host e Origin de sempre.
- **Requisições remotas:** precisam do token, enviado de uma de duas formas:
  - no cabeçalho `Authorization: Bearer <token>`, para scripts;
  - no cookie `adelic_session`, criado por `POST /api/auth/login`. É `HttpOnly` e `SameSite=Strict` e vale por 30 dias. O token não fica no armazenamento da página.
- **Sem token:** só a tela de login e os arquivos estáticos da interface são servidos. Todas as rotas `/api/` respondem 401, inclusive o fluxo de eventos e a exportação.
- **Alterações com cookie** precisam vir da mesma origem e com `application/json`, como proteção contra CSRF.
- **Tentativas de login:** no máximo 5 falhas por endereço por minuto; depois disso, responde 429.
- **Sair:** `POST /api/auth/logout` apaga o cookie.

## Limites

- **HTTP sem TLS:** o tráfego vai em HTTP simples. Use só dentro de uma rede cifrada como a Tailscale, ou atrás de um proxy com HTTPS. Não exponha a porta à internet.
- **Um token só:** quem tem o token tem acesso completo, com as mesmas permissões dos agentes que você configurou. Não há usuários nem papéis.
- **Trocar o token:** reinicie o Adelic com outro valor. Os cookies antigos deixam de valer.
- **Desktop:** o app desktop herda as variáveis do ambiente em que é aberto. Se elas estiverem definidas lá, o acesso remoto também abre.

## Validação

`tests/remote-access.test.ts` usa `127.0.0.2`, um endereço de loopback que o Adelic não considera local. Assim o caminho remoto é testado sem expor nada na rede. Os testes cobrem:

- configuração ausente, fraca ou com endereço curinga;
- token obrigatório para as rotas remotas, com o loopback continuando sem token;
- login com cookie `HttpOnly` e `SameSite=Strict`;
- bloqueio de alterações vindas de outra origem;
- limite de tentativas;
- proteção do fluxo de eventos e da exportação.

O fluxo no navegador (tela de login, token errado, entrada) foi conferido manualmente por um relay que se conecta a partir de `127.0.0.2`.
