import { expect, test, type Page } from './fixtures';
import { funnelPort } from '../../playwright.config';

// Remote login (docs/specs/remote-access.md). The E2E server has a second loopback listener in
// the Tailscale Funnel role: every request on it is classified as internet, so this covers the
// real login path without exposing anything. The `tailscale` CLI is scripted (tests/e2e/server.ts).
const funnel = `http://127.0.0.1:${funnelPort}`;
const PASSWORD = 'uma frase longa de teste';

async function openSettings(page: Page) {
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  const card = page.getByRole('region', { name: 'Acesso remoto' });
  await card.scrollIntoViewIfNeeded();
  return card;
}

test.describe.configure({ mode: 'serial' });

test('creates the account on this computer and publishes Funnel only after confirming', async ({ page }) => {
  await page.goto('/');
  const card = await openSettings(page);
  await expect(card.getByText('Nenhuma conta criada')).toBeVisible();
  // Funnel needs the account first.
  await expect(card.getByRole('button', { name: 'Publicar na internet' })).toBeDisabled();
  await card.getByRole('button', { name: 'Criar conta' }).click();
  await card.getByRole('textbox', { name: 'Usuário' }).fill('dono');
  await card.getByLabel('Nova senha').fill('curta');
  await expect(card.getByText('A senha deve ter pelo menos 12 caracteres.')).toBeVisible();
  await card.getByLabel('Nova senha').fill(PASSWORD);
  await expect(card.getByText(/Força: (Aceitável|Boa|Forte)/)).toBeVisible();
  await card.getByLabel('Repita a senha').fill(`${PASSWORD}x`);
  await expect(card.getByText('As senhas não conferem.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Salvar conta' })).toBeDisabled();
  await card.getByLabel('Repita a senha').fill(PASSWORD);
  await card.getByRole('button', { name: 'Salvar conta' }).click();
  await expect(card.getByText('Conta: dono')).toBeVisible();
  // Tailscale status from the scripted CLI.
  const status = card.getByRole('definition').filter({ hasText: 'adelic-e2e.exemplo.ts.net' });
  await expect(status).toBeVisible();
  await card.getByRole('button', { name: 'Publicar na internet' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Publicar o Adelic na internet?' });
  await expect(dialog).toContainText('qualquer pessoa na internet');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  await card.getByRole('button', { name: 'Publicar na internet' }).click();
  await dialog.getByRole('button', { name: 'Publicar' }).click();
  await expect(card.getByText('Publicado em https://adelic-e2e.exemplo.ts.net/.')).toBeVisible();
  await card.getByRole('button', { name: 'Desligar' }).click();
  await expect(card.getByRole('button', { name: 'Publicar na internet' })).toBeVisible();
});

test('logs in from the internet, shows the session and logs out, at 360px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, baseURL: funnel });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Entrar no Adelic' })).toBeVisible();
  await expect(page.getByText('Acesso pela internet.')).toBeVisible();
  // No token option from the internet.
  await expect(page.getByRole('button', { name: /token/ })).toHaveCount(0);
  const form = page.getByRole('form', { name: 'Entrar no Adelic' });
  const box = (await form.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await page.getByLabel('Usuário').fill('dono');
  await page.getByLabel('Senha').fill('senha errada qualquer');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toHaveText('Usuário ou senha incorretos.');
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Entrar no Adelic' })).toBeHidden();
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  const card = await openSettings(page);
  const sessions = card.getByRole('list', { name: 'Sessões ativas' });
  await expect(sessions.getByText('esta sessão')).toBeVisible();
  await expect(sessions).toContainText('Internet');
  // Credentials and Funnel cannot change from here.
  await expect(card.getByRole('button', { name: 'Trocar senha' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Publicar na internet' })).toHaveCount(0);
  await expect(card.getByRole('switch', { name: /exigir aprovação manual/ })).toBeDisabled();
  await card.getByText(/^Últimos acessos/).click();
  await expect(card.getByRole('list', { name: 'Últimos acessos' })).toContainText('Falhou (senha incorreta)');
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await sessions.getByRole('button', { name: 'Sair' }).click();
  await expect(page.getByRole('heading', { name: 'Entrar no Adelic' })).toBeVisible();
  expect((await page.request.get('/api/bootstrap')).status()).toBe(401);
  await context.close();
});

test('the computer can end internet sessions', async ({ page, browser }) => {
  const remote = await browser.newContext({ baseURL: funnel });
  const login = await remote.request.post('/api/auth/login', {
    data: { username: 'dono', password: PASSWORD },
    headers: { 'user-agent': 'E2E Phone Android' },
  });
  expect(login.status()).toBe(200);
  // The cookie is Secure (Funnel is HTTPS); the API client does not replay it over http, so send it.
  const cookie = { cookie: login.headers()['set-cookie'].split(';')[0] };
  expect((await remote.request.get('/api/bootstrap', { headers: cookie })).status()).toBe(200);
  await page.goto('/');
  const card = await openSettings(page);
  const sessions = card.getByRole('list', { name: 'Sessões ativas' });
  await expect(sessions).toContainText('Android');
  await card.getByRole('button', { name: 'Encerrar todas' }).click();
  await expect(card.getByText('Nenhuma sessão aberta.')).toBeVisible();
  expect((await remote.request.get('/api/bootstrap', { headers: cookie })).status()).toBe(401);
  await remote.close();
});
