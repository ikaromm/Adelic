import { expect, test, type Page } from './fixtures';
import { funnelPort } from '../../playwright.config';

// English UI (docs/i18n.md): Settings › Idioma switches the interface at once, is saved on the
// server (Settings.language) and mirrored in localStorage for the login screen. The E2E server's
// Funnel listener (remote-login.spec.ts) is always "internet": it covers the connection badge, the
// forced manual approval and the server's translated errors without exposing anything.
const funnel = `http://127.0.0.1:${funnelPort}`;
const PASSWORD = 'uma frase longa de teste';

async function setLanguage(page: Page, value: 'pt-BR' | 'en' | 'auto') {
  const response = await page.request.patch('/api/settings', { data: { language: value } });
  expect(response.ok()).toBe(true);
}

test.describe.configure({ mode: 'serial' });
test.afterAll(async ({ request }) => {
  await request.patch('/api/settings', { data: { language: 'auto' } });
});

test('switches to English in Settings, persists across reloads and switches back', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();
  const language = page.getByRole('combobox', { name: 'Idioma / Language' });
  await expect(language).toHaveValue('auto');
  await language.selectOption('en');
  // The page re-renders in English at once.
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('button', { name: 'Observability' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Automations' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^New conversation/ }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Standalone conversations' })).toBeVisible();
  await expect(page.locator('.local-badge')).toHaveText('Local');
  await expect(page.locator('.local-badge')).toHaveAttribute('title', /Runs on this computer/);
  // Saved on the server, so a reload (or another device) keeps it.
  await expect.poll(async () => (await (await page.request.get('/api/bootstrap')).json()).settings.language).toBe('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // Composer in English.
  await page
    .getByRole('button', { name: /^New conversation/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Message to the agent' });
  await expect(input).toHaveAttribute('placeholder', 'Write a message…');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Access: / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan first' })).toBeVisible();
  await page.getByRole('button', { name: /^Conversation project and mode: No project · Auto$/ }).click();
  await expect(page.getByRole('dialog', { name: 'Conversation project and mode' })).toContainText('Thorough');
  await page.keyboard.press('Escape');
  // Back to Portuguese.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('combobox', { name: 'Idioma / Language' }).selectOption('pt-BR');
  await expect(page.getByRole('heading', { name: 'Configurações', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
  await setLanguage(page, 'auto');
});

test('auto follows the browser language', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await context.close();
});

test('login screen, connection badge, forced approval and server errors in English from the internet', async ({
  page,
  browser,
}) => {
  // The account is created on this computer and removed at the end: remote-login.spec.ts runs
  // later and starts without one.
  await page.goto('/');
  const created = await page.request.put('/api/remote-access/account', {
    data: { username: 'dono', password: PASSWORD },
  });
  expect(created.ok()).toBe(true);
  const english = await browser.newContext({ baseURL: funnel, locale: 'en-US' });
  try {
    const remote = await english.newPage();
    // Before login the language comes from localStorage or, with `auto`, from the browser.
    await remote.goto('/');
    await expect(remote.getByRole('heading', { name: 'Sign in to Adelic' })).toBeVisible();
    await expect(remote.getByText('Internet access.')).toBeVisible();
    // The server answers in the client's language (Accept-Language), pt-BR when asked.
    const refused = await remote.request.post('/api/auth/login', {
      data: { username: 'dono', password: 'senha errada qualquer' },
      headers: { 'accept-language': 'en' },
    });
    expect(refused.status()).toBe(401);
    expect((await refused.json()).error).toBe('Incorrect username or password');
    const refusedPt = await remote.request.post('/api/auth/login', {
      data: { username: 'dono', password: 'senha errada qualquer' },
      headers: { 'accept-language': 'pt-BR' },
    });
    expect((await refusedPt.json()).error).toBe('Usuário ou senha incorretos');
    await remote.getByLabel('Username').fill('dono');
    await remote.getByLabel('Password').fill(PASSWORD);
    await remote.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(remote.getByRole('heading', { name: 'Sign in to Adelic' })).toBeHidden();
    // Connection badge: internet, warning tone, with an explanation.
    const badge = remote.locator('.local-badge');
    await expect(badge).toHaveText('Internet');
    await expect(badge).toHaveAttribute('data-kind', 'internet');
    await expect(badge).toHaveAttribute('title', /Tailscale Funnel/);
    // Runs from the internet use manual approval; other approval modes are disabled.
    await remote
      .getByRole('button', { name: /^New conversation/ })
      .first()
      .click();
    const pill = remote.getByRole('button', { name: /^Access: Read only$/ });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('title', /Manual · Internet access requires manual approval/);
    await pill.click();
    const menu = remote.getByRole('dialog', { name: 'Access' });
    await expect(menu.getByRole('button', { name: /^Safe automatic/ })).toBeDisabled();
    await expect(menu.getByRole('button', { name: /^Manual/ })).toBeDisabled();
    await expect(menu).toContainText('Current: Manual · Internet access requires manual approval.');
    const bootstrap = await (await page.request.get('/api/bootstrap')).json();
    const providerId = bootstrap.settings.defaultProviderId;
    const provider = bootstrap.providers.find((item: { id: string }) => item.id === providerId);
    const supportsAutomatic = (provider?.id === 'codex' || provider?.id === 'kiro') && provider.capabilities.tools;
    if (supportsAutomatic) await expect(menu.getByRole('button', { name: /^Automatic/ })).toBeDisabled();
    else await expect(menu.getByRole('button', { name: /^Automatic/ })).toHaveCount(0);
  } finally {
    await english.close();
    expect((await page.request.delete('/api/remote-access/account', { data: {} })).ok()).toBe(true);
  }
});

test('on this computer the badge says Local and approval options reflect runtime capability', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.locator('.local-badge')).toHaveAttribute('data-kind', 'local');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  const pill = page.getByRole('button', { name: /^Acesso: / });
  await expect(pill).toBeVisible();
  await pill.click();
  const menu = page.getByRole('dialog', { name: 'Acesso' });
  await expect(menu.getByRole('button', { name: /^Automático seguro/ })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Manual/ })).toBeEnabled();
  const bootstrap = await (await request.get('/api/bootstrap')).json();
  const providerId = bootstrap.settings.defaultProviderId;
  const provider = bootstrap.providers.find((item: { id: string }) => item.id === providerId);
  const supportsAutomatic = (provider?.id === 'codex' || provider?.id === 'kiro') && provider.capabilities.tools;
  if (supportsAutomatic) await expect(menu.getByRole('button', { name: /^Automático(?! seguro)/ })).toBeEnabled();
  else await expect(menu.getByRole('button', { name: /^Automático(?! seguro)/ })).toHaveCount(0);
});
