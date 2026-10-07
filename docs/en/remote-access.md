# Remote access (optional)

> Translated from the Portuguese original: [docs/specs/remote-access.md](../specs/remote-access.md).

By default, Adelic listens only on `127.0.0.1`, and whoever uses this computer does not sign in. There are two optional ways to open it from another device, both with a **username and password**:

- **Tailnet:** through the computer's Tailscale IP (`ADELIC_REMOTE_BIND`) or through `tailscale serve`. Reaches only your own devices.
- **Internet:** through **Tailscale Funnel**, at `https://<machine>.<tailnet>.ts.net/`, from anywhere.

The badge at the top of the window shows whether the current connection is Local, Tailnet or Internet.

## How each request is classified

Classification happens before any route (`classifyRequest` in `server/http/auth.ts`). When in doubt, the request is treated as internet.

| Source                                                                                                         | Type       | Sign-in        |
| -------------------------------------------------------------------------------------------------------------- | ---------- | -------------- |
| Loopback socket on `127.0.0.1:4317`, without proxy headers                                                     | `local`    | no             |
| `ADELIC_REMOTE_BIND` listener (without proxy headers)                                                          | `tailnet`  | yes (or token) |
| Loopback with `Tailscale-User-Login` (`tailscale serve`) and no Funnel marker                                  | `tailnet`  | yes (or token) |
| Funnel listener (`127.0.0.1:ADELIC_FUNNEL_PORT`), with any headers                                             | `internet` | yes, user only |
| Loopback with `Tailscale-Funnel-Request`                                                                       | `internet` | yes, user only |
| Loopback with any other proxy header (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Via`…), or any other address | `internet` | yes, user only |

The strongest signal is the **port**: Funnel points to a dedicated listener, and everything that arrives there is internet. Headers are a second line of defense, based on what tailscaled 1.102 sends: on Funnel, `Tailscale-Funnel-Request: ?1` and `X-Forwarded-For`, without identity; on `serve`, `Tailscale-User-Login`. tailscaled strips these headers when the client sends them. The forwarded address is used only when the socket is loopback and the request came from Funnel or `serve`.

## Account

There is a single account, the owner's. It can only be created or changed **on this computer**, never through remote access:

- **Settings › Remote access › Create account**, or
- `npm run remote-user -- set <username>`, which asks for the password twice without echoing it. The `status`, `revoke-sessions` and `delete` commands also exist. It works while Adelic is open.

Rules: the username has 3 to 64 characters (`a-z`, `0-9`, `.`, `_`, `-`). The password has at least 12 characters and cannot equal the username; the screen shows strength hints. The password is stored with scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key), and the parameters are kept with the hash. **Changing the password ends all sessions.**

## Sessions and sign-in

- The `adelic_session` cookie holds a random 32-byte id, and the database stores only its SHA-256. The cookie is `HttpOnly; SameSite=Strict; Path=/`, and also `Secure` when TLS terminates in tailscaled (Funnel or `serve`).
- A session expires after 7 days without use and at most 30 days after sign-in. **Sign out** deletes the session on the server.
- Settings lists active sessions with device, type, IP and last use, and offers **End** and **End all**. Event streams of an ended session are closed.
- Sign-in errors use a single message: "Incorrect username or password".
- Limits: 5 failures per minute per address (the forwarded one, on Funnel), with 429 after that. Beyond 20 failures in 10 minutes overall, each attempt waits a delay that doubles up to 30 s. The account is never locked permanently. **Recent sign-ins** shows the 200 most recent sign-ins, successful or not, with IP and device.
- Cookie-authenticated changes require the same origin and `application/json` (CSRF).

## Funnel

**Settings › Remote access** shows the Tailscale state: whether it is installed and connected, the MagicDNS name, and whether HTTPS and Funnel are allowed. It also shows the **Publish to the internet** button, which is only enabled when the account exists and asks for confirmation first. Funnel never turns on by itself.

Commands run (with `execFile`, a timeout and no shell):

```bash
tailscale funnel --bg --yes --https=443 --set-path=/ http://127.0.0.1:4319   # Publish
tailscale funnel --yes --https=443 --set-path=/ off                          # Turn off
tailscale status --json; tailscale funnel status --json                      # state
```

- The local port comes from `ADELIC_FUNNEL_PORT` (default `4319`, always on `127.0.0.1`). The listener only opens when Funnel is requested.
- If `https://<machine>/` already publishes another target, Adelic does not replace it.
- Adelic stores only `funnel.wanted` and the port. On startup, it reapplies Funnel (an idempotent operation) only if it was on **and** the account still exists. Deleting the account turns Funnel off.

What the tailnet needs to allow (the card points out what is missing, with a link):

1. MagicDNS and **HTTPS Certificates** under [DNS](https://login.tailscale.com/admin/dns).
2. The `funnel` attribute for this device in `nodeAttrs`, in the [access control file](https://login.tailscale.com/admin/acls/file), with port 443 allowed (default: 443, 8443 and 10000).
3. Your user can change Tailscale without sudo: `sudo tailscale set --operator=$USER`, once.

## What is blocked over the internet

Even with a valid sign-in, these operations get `403`:

- The project terminal, always, even with **Allow the terminal over remote access** on (that option applies only to the tailnet).
- Changes to MCP servers, automations (including the master switch), project checks and blocks, and `git push`.
- Creating, changing or deleting the account, turning Funnel on or off, viewing the Tailscale state and changing remote access options. The tailnet cannot do this either: only this computer can. Ending sessions remains possible from any session.
- The `ADELIC_REMOTE_TOKEN` token (`Bearer` or token sign-in).

Approvals keep working over the internet. With **Over the internet, require manual approval for commands** on (the default), every run started from an internet session uses `approvalMode: 'manual'`, and the permissions selector shows it. This applies to messages, the queue, edit and resend, retry, approved plan tasks and auto-fix; the global setting does not change.

## Headers

Every response carries `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and the app CSP with `frame-ancestors 'none'`; the preview is allowed through `frame-src`. When TLS terminates in tailscaled, responses also carry `Strict-Transport-Security: max-age=31536000`.

## Migrating from the token

`ADELIC_REMOTE_BIND` and `ADELIC_REMOTE_TOKEN` (32+ characters) keep working on the tailnet. Token sign-in now creates a random session, and the cookie no longer contains the token itself; old cookies stop working. When an account exists, the sign-in screen asks for username and password, and the token remains an alternative on the tailnet only. To migrate, create the account and, whenever you like, remove `ADELIC_REMOTE_TOKEN`. `ADELIC_REMOTE_BIND` requires a token, so to use only the account, prefer `tailscale serve` or Funnel. The data lives in SQLite migration 12: `remote_users`, `remote_sessions` and `remote_logins`.

## Threat model and limits

- **Whoever signs in controls the agents:** with the username and password, someone can read and change files and run commands through the agents, within the configured permissions. The internet restrictions reduce the reach, but do not replace a strong, unique password.
- **No second factor:** there is no 2FA, and no multiple users or roles. Attempt limits slow down guessing, but do not prevent it forever.
- **Your own proxy:** a reverse proxy of your own, such as nginx or Caddy, is treated as internet: there is no "trusted proxy" mode.
- **HTTP on the tailnet:** the `ADELIC_REMOTE_BIND` listener uses plain HTTP. Traffic is encrypted by Tailscale, but the browser does not consider it a secure context (no `crypto.randomUUID`, clipboard or microphone; the interface works without them). For HTTPS on the tailnet, use `tailscale serve`.
- **Desktop:** the desktop app inherits the environment variables of the environment it is opened from.
- **Turning off:** if Adelic closes, Tailscale keeps Funnel pointing at the port, which stops responding. Click **Turn off** to remove the publication.

## Validation

`tests/remote-access.test.ts` covers the classification matrix (socket address and port × headers, with the Funnel port always internet), scrypt and the password policy, session hashing at rest and expiry, revocation, cookie attributes, rate limits, refusal of `Bearer` over the internet, blocked routes, forced manual approval, headers, the CLI, and the Funnel commands against a fake `tailscale` (never the real one). `tests/e2e/remote-login.spec.ts` covers account creation and publishing with confirmation on this computer, and, through the E2E server's Funnel port, sign-in, a wrong password, the session list and sign-out at 360 px.
