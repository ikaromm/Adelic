# Fontes em E2E visuais — 2026-10-09

## Configuração

- `tests/e2e/fontconfig-test.conf` é a configuração pública usada pelo Playwright: considera somente `/usr/share/fonts` e grava cache em `/tmp/adelic-playwright-fontconfig-cache`.
- `playwright.config.ts` cria esse diretório e define `FONTCONFIG_FILE` antes da inicialização dos browsers. Não redefine `XDG_CACHE_HOME`, que o Playwright usa para localizar seus browsers, e não altera configurações pessoais.
- A aplicação já empacota Inter Variable e JetBrains Mono Variable em `src/main.tsx`; o spec valida que ambas carregam antes dos snapshots.
- Para os testes deste registro, o Chromium disponível foi `/usr/bin/chromium`, versão `152.0.7977.82`.

## Verificações

Com `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium npx playwright test tests/e2e/visual-regression.spec.ts`, os quatro testes passaram (4/4). Foram conferidas Settings, SSH, composer, model picker e Acesso em viewports de 1280×900 e 390×900. Os metadados anexados pelo teste registraram `fontChecks.inter=true` e `fontChecks.jetBrainsMono=true`; os snapshots de Settings/SSH, composer e model picker passaram sem atualização.

O diagnóstico recebido para esta tarefa atribui a divergência restante de Acesso a dois glifos ✓ renderizados por fallback de fonte. Para remover essa dependência sem mudar o significado dos estados, os quatro indicadores agora usam o SVG `Check` do conjunto de ícones já usado pela interface; os botões continuam expondo o estado por `aria-pressed` e o desenho permanece decorativo (`aria-hidden`). Só as duas referências de Acesso (`access-1280-linux.png` e `access-390-linux.png`) foram atualizadas. Ambas passaram na execução final; a troca visual do glifo gerou diferença de 34 pixels contra as referências antigas em cada viewport, antes da atualização localizada.

## Limites

A execução confirma snapshots neste executor Linux, Chromium 152 e Fontconfig com a configuração acima. Não comprova equivalência de rasterização em outros sistemas, browsers ou versões de fonte. As capturas e JSONs de evidência ficam nos artefatos locais de `test-results/`; não foram adicionados ao Git. A primeira tentativa sem `PLAYWRIGHT_CHROMIUM` não encontrou o Chromium baixado pelo Playwright; por isso a validação usou o executável de sistema explicitamente.
