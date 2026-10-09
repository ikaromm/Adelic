# Evidências de regressão visual — 2026-10-09

## Escopo e resultado

A investigação executou `tests/e2e/visual-regression.spec.ts` no executor local usando Chromium do sistema, sem alterar snapshots, tolerâncias, fontes, configuração pessoal ou referências visuais.

Resultado: **2/4 casos passaram**. Settings/SSH passaram em 1280×900 e 390×900; composer e model picker também passaram nas duas larguras; os dois casos que incluem o menu Acesso falharam exatamente no snapshot de Acesso, com 14 pixels diferentes (relatório Playwright: ratio 0.01). Os 14 pixels coincidem com a divergência pequena reportada pelo worker. Não há evidência nesta execução que explique as divergências maiores reportadas no host.

## Ambiente efetivamente medido

Capturas e JSONs completos ficam em `test-results/visual-regression-*/visual-evidence-*` após executar os testes. Playwright também deixa actual/diff/expected e trace para as falhas.

Valores medidos em `visual-evidence-access.json`:

- Chromium headless **152.0.7977.82** (`/usr/bin/chromium`); Playwright **1.63.0**; Node **v26.8.1**; Linux x64.
- Viewport desktop **1280×900** e mobile **390×900**; `devicePixelRatio=1`, `visualViewport.scale=1`; contexto configurado com locale pt-BR; timezone UTC. Não houve emulação de escala/zoom.
- `navigator.userAgent` identifica HeadlessChrome 152. O Playwright usa viewport e locale definidos em `playwright.config.ts`; a spec fixa altura 900 e as larguras 1280/390.
- `--font-sans` computado é Inter Variable; `document.fonts.check` retorna true para Inter Variable e JetBrains Mono Variable, e a spec exige que ambas carreguem antes de snapshots. Os assets de fonte estão em `dist/assets/*woff2`.
- O ambiente não tem configuração Fontconfig padrão carregável (o comando `fc-match` emitiu “Cannot load default config file”); seu fallback sistêmico é Adwaita Sans/Mono. Isso **não demonstra a causa**: fontes web empacotadas foram carregadas durante os casos e os snapshots de Settings, SSH, composer e model picker passaram.

## Limite da comparação com o host

Não há nesta execução capturas/JSONs nem versão do navegador, viewport real, DPR/zoom, locale/timezone ou configuração Fontconfig do host para comparação par-a-par. O relato do host informa build e fontes empacotadas carregando, mas essas confirmações não substituem os metadados ambientais. Portanto, as divergências grandes do host (2729/1942/1761/1354 pixels) permanecem sem causa comprovada; não atribuo a fontes, browser, escala ou configuração do desktop. Não alterei configuração pessoal do host.

## Reproduzir

No executor:
```sh
npx vite build --configLoader runner
PLAYWRIGHT_CHROMIUM=/usr/bin/chromium npx playwright test tests/e2e/visual-regression.spec.ts --reporter=list --timeout=20000
```

A spec agora grava PNGs e JSONs por viewport/cena no diretório de saída Playwright (`test-results`) e os anexa ao resultado. JSON contém browser/UA, plataforma, viewport, DPR/escala, idioma, timezone, esquema de cor, geometria e estilo tipográfico do elemento, estado/carregamento das fontes e metadados da captura. Os snapshots existentes e a política de comparação permanecem intactos.

O comando `npm run build` foi tentado antes da execução; `tsc` passou, mas Vite não pôde gravar `node_modules/.vite-temp` (filesystem read-only). A build usada nos testes, `npx vite build --configLoader runner`, passou. `npm run typecheck` e `npx prettier --check tests/e2e/visual-regression.spec.ts` passaram depois da instrumentação.
