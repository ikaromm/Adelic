# App instalável (PWA)

O Adelic aberto no navegador pode ser instalado como app, por exemplo no celular pelo [acesso remoto](remote-access.md). O app instalado é só a interface: os dados e os agentes continuam no computador, e sem conexão com ele aparece a página "Sem conexão com o Adelic".

## Requisitos

- **Contexto seguro:** o navegador só registra o service worker e oferece a instalação em HTTPS ou em `localhost`/`127.0.0.1`. Pelo IP Tailscale em HTTP simples (`http://100.x.y.z:4318`) não há instalação. Para o celular, publique o endereço remoto com HTTPS, por exemplo com `tailscale serve`, que só alcança dispositivos da sua tailnet.
- **Build de produção:** em `npm run dev` nada é registrado.
- **Desktop:** o app Electron (`Electron/` no user agent) nunca registra o service worker.
- **Instalar:** em Configurações › Diagnóstico, **Instalar como app** aparece quando o navegador oferece a instalação (`beforeinstallprompt`). No iPhone, use Compartilhar › Adicionar à Tela de Início.

## O que fica em cache

O cache é a "casca" da interface, listada no build (`vite.config.ts` gera `dist/sw.js`):

- `index.html`, `offline.html`, os arquivos com hash de `assets/` (JS, CSS e fontes), o manifesto, `favicon.svg` e os ícones.
- Baixados na instalação, sem cookies (`credentials: 'omit'`) e sem o cache HTTP. Só entram respostas 200 da mesma origem, sem `Set-Cookie` e sem `Cache-Control: private` ou `no-store`.
- Os arquivos da casca vêm do cache. A abertura de páginas vai sempre primeiro à rede, nunca é guardada e usa a página offline só se a rede falhar.

## O que nunca fica em cache

- `/api/*`, incluindo o fluxo de eventos (`/api/events`), a exportação e os anexos, e `/events`: o service worker nem responde a essas requisições.
- Requisições que não são GET, de outra origem, com `Authorization`, ou com query string.
- Qualquer arquivo fora da lista do build.

Assim, sem o token do acesso remoto, o cache só tem o mesmo que o servidor já entrega publicamente: a casca e os ícones.

## Atualizações

- A versão do cache (`adelic-shell-<hash>`) é um hash dos arquivos da casca. Ao ativar, caches `adelic-*` de outras versões são apagados.
- Uma versão nova instala em segundo plano e fica esperando. O aviso **Atualização disponível — Recarregar** pede ao worker que assuma (`skipWaiting`) e recarrega a página. Sem o clique, a versão atual continua.
- O app procura atualizações ao abrir e quando volta a ficar visível.

## Servidor

- `sw.js`: `Cache-Control: no-cache` e `Service-Worker-Allowed: /`.
- `manifest.webmanifest`: `application/manifest+json` e `no-cache`. As páginas HTML e a rota da SPA usam `no-cache`.
- O guard de acesso (`server/http/auth.ts`) roda antes dos arquivos estáticos. Nada novo fica público além da casca e dos ícones.

## Ícones

Os PNGs em `public/icons/` (192, 512, maskable 512 e apple-touch 180) vêm da marca em `public/favicon.svg`, gerados com `node scripts/generate-pwa-icons.mjs` (precisa de `rsvg-convert`). Os ícones maskable e Apple são quadrados cheios, com a marca dentro da zona segura.

## Validação

- `tests/pwa.test.ts`: manifesto (campos, cores do tema, tamanhos reais dos PNGs), classificação das requisições, versões de cache e o ciclo do worker num escopo simulado.
- `tests/pwa-server.test.ts`: cabeçalhos e a casca pública no endereço remoto, com `/api` protegido.
- `tests/e2e/pwa.spec.ts`: registro e controle depois de recarregar, cache sem `/api`, página offline (`context.setOffline`) e aviso de atualização. As outras specs rodam com `serviceWorkers: 'block'` (`playwright.config.ts`), para que nenhum cache passe de um teste para outro.
