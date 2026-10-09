import { expect, test, type Locator, type Page } from './fixtures';
import type { TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function assertBundledFonts(page: Page) {
  const loaded = await page.evaluate(async () => {
    const sample = 'Configurações São Paulo ação número';
    const [sans, mono] = await Promise.all([
      document.fonts.load('400 14px "Inter Variable"', sample),
      document.fonts.load('400 14px "JetBrains Mono Variable"', sample),
    ]);
    await document.fonts.ready;
    return {
      sans:
        sans.length > 0 &&
        sans.every((face) => face.status === 'loaded') &&
        document.fonts.check('400 14px "Inter Variable"', sample),
      mono:
        mono.length > 0 &&
        mono.every((face) => face.status === 'loaded') &&
        document.fonts.check('400 14px "JetBrains Mono Variable"', sample),
    };
  });
  expect(loaded, 'bundled UI fonts should load before visual snapshots').toEqual({ sans: true, mono: true });
}

async function attachVisualEvidence(page: Page, locator: Locator, testInfo: TestInfo, label: string) {
  await page.evaluate(() => document.fonts.ready);
  const screenshot = await locator.screenshot({ animations: 'disabled' });
  const selector = await locator.evaluate((element) => {
    if (!element.id) element.id = 'visual-evidence-target';
    return `#${CSS.escape(element.id)}`;
  });
  const environment = await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    const style = element ? getComputedStyle(element) : null;
    const rect = element?.getBoundingClientRect();
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: { width: innerWidth, height: innerHeight },
      screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
      devicePixelRatio,
      visualViewportScale: visualViewport?.scale ?? null,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      element:
        rect && style
          ? {
              selector,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              letterSpacing: style.letterSpacing,
            }
          : null,
      fonts: [...document.fonts].map(({ family, style, weight, status }) => ({ family, style, weight, status })),
      fontChecks: {
        inter: document.fonts.check('400 14px "Inter Variable"', 'Configurações São Paulo ação número'),
        jetBrainsMono: document.fonts.check(
          '400 14px "JetBrains Mono Variable"',
          'Configurações São Paulo ação número',
        ),
      },
    };
  }, selector);
  await testInfo.attach(`${label}-${testInfo.project.name}-${testInfo.title.replaceAll(/[^a-z0-9]+/gi, '-')}.png`, {
    body: screenshot,
    contentType: 'image/png',
  });
  const metadata = Buffer.from(
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        browserVersion: page.context().browser()?.version() ?? 'unknown',
        project: testInfo.project.name,
        test: testInfo.title,
        screenshot: {
          width: Math.round(environment.element?.rect.width ?? 0),
          height: Math.round(environment.element?.rect.height ?? 0),
          bytes: screenshot.byteLength,
        },
        ...environment,
      },
      null,
      2,
    ),
  );
  const slug = label.replaceAll(/[^a-z0-9]+/gi, '-');
  await writeFile(testInfo.outputPath(`visual-evidence-${slug}.png`), screenshot);
  await writeFile(testInfo.outputPath(`visual-evidence-${slug}.json`), metadata);
  await testInfo.attach(`${label}-environment.json`, {
    body: metadata,
    contentType: 'application/json',
  });
}

for (const width of [1280, 390]) {
  test(`settings and SSH visual regression at ${width}px`, async ({ page, request }) => {
    await request.patch('/api/settings', { data: { language: 'pt-BR' } });
    await page.route('**/api/remote-hosts', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/remote-hosts/ssh-config', (route) =>
      route.fulfill({ json: { aliases: ['desenvolvimento', 'homologacao'] } }),
    );
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('button', { name: 'Configurações' })
      .click();
    await page.setViewportSize({ width, height: 900 });
    await assertBundledFonts(page);
    const settings = page.locator('.settings-discovery');
    await attachVisualEvidence(page, settings, test.info(), 'settings-discovery');
    await expect(settings).toHaveScreenshot(`settings-discovery-${width}.png`);
    await page.getByRole('searchbox', { name: 'Buscar configurações' }).fill('SSH');
    const card = page.getByRole('region', { name: 'Servidores SSH' });
    await expect(card.getByLabel('Servidor do ~/.ssh/config')).toContainText('desenvolvimento');
    await attachVisualEvidence(page, card, test.info(), 'ssh-setup');
    await expect(card).toHaveScreenshot(`ssh-setup-${width}.png`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await request.patch('/api/settings', { data: { language: 'auto' } });
  });

  test(`composer and model picker visual regression at ${width}px`, async ({ page, request }) => {
    await request.patch('/api/settings', { data: { language: 'pt-BR', sandbox: 'read-only', approvalMode: 'manual' } });
    await page.goto('/');
    await page.locator('.new-chat-button').click();
    await page.setViewportSize({ width, height: 900 });
    await assertBundledFonts(page);
    const composer = page.locator('.composer-box');
    await attachVisualEvidence(page, composer, test.info(), 'composer');
    await expect(composer).toHaveScreenshot(`composer-${width}.png`);
    await page.getByRole('button', { name: /^Escolher modelo e provedor/ }).click();
    const modelPicker = page.getByRole('dialog', { name: 'Escolher modelo e provedor' });
    await attachVisualEvidence(page, modelPicker, test.info(), 'model-picker');
    await expect(modelPicker).toHaveScreenshot(`model-picker-${width}.png`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Acesso:/ }).click();
    const access = page.getByRole('dialog', { name: 'Acesso' });
    await attachVisualEvidence(page, access, test.info(), 'access');
    await expect(access).toHaveScreenshot(`access-${width}.png`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await request.patch('/api/settings', { data: { language: 'auto' } });
  });
}
