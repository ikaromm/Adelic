import { expect, test, type Page } from './fixtures';

// System notifications while the window is in the background (src/hooks/useRunNotifications.ts).
// window.Notification is replaced by a recorder and the page pretends to be hidden and
// unfocused, so no real notification appears and the browser permission is not involved.

declare global {
  interface Window {
    __notices: { title: string; body: string; tag?: string; click: () => void }[];
    __permission: NotificationPermission;
    __permissionAnswer: NotificationPermission;
    __background: boolean;
  }
}

async function stubNotifications(page: Page, permission: NotificationPermission, answer: NotificationPermission) {
  await page.addInitScript(
    ([initial, reply]) => {
      window.__notices = [];
      window.__permission = initial;
      window.__permissionAnswer = reply;
      window.__background = false;
      class RecordingNotification {
        static get permission() {
          return window.__permission;
        }
        static async requestPermission() {
          window.__permission = window.__permissionAnswer;
          return window.__permission;
        }
        onclick: (() => void) | null = null;
        constructor(title: string, options: { body: string; tag?: string }) {
          window.__notices.push({ title, body: options.body, tag: options.tag, click: () => this.onclick?.() });
        }
        close() {}
      }
      Object.defineProperty(window, 'Notification', { value: RecordingNotification, configurable: true });
      Object.defineProperty(Document.prototype, 'hidden', { get: () => window.__background, configurable: true });
      Document.prototype.hasFocus = () => !window.__background;
    },
    [permission, answer] as const,
  );
}

async function enableInSettings(page: Page) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  const toggle = page.getByRole('switch', { name: 'Notificar quando terminar' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  return toggle;
}

async function send(page: Page, text: string) {
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill(text);
  await page.evaluate(() => (window.__background = true));
  await input.press('Enter');
}

const notices = (page: Page) =>
  page.evaluate(() => window.__notices.map(({ title, body, tag }) => ({ title, body, tag })));

// The database is shared across tests: leave the setting as the browser default (off).
test.afterEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { notifications: false } });
});

test('asks permission, then notifies a finished answer in the background and opens it on click', async ({ page }) => {
  await stubNotifications(page, 'default', 'granted');
  const toggle = await enableInSettings(page);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const title = `[normal] notificar ${Date.now()}`;
  await send(page, title);
  await expect
    .poll(() => notices(page))
    .toContainEqual(expect.objectContaining({ title: 'Resposta pronta', body: title }));
  // Only the conversation title: never the answer itself.
  expect(JSON.stringify(await notices(page))).not.toContain('E2E');
  await expect(page).toHaveTitle(/^\(1\) /);
  expect((await notices(page)).filter((n) => n.title === 'Resposta pronta')).toHaveLength(1);

  // Switch away, then click the notification: the window comes back to that conversation.
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Conversa', exact: true }).getByText(title)).toBeHidden();
  await page.evaluate(() => {
    window.__background = false;
    window.__notices.find((n) => n.title === 'Resposta pronta')?.click();
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('region', { name: 'Conversa', exact: true }).getByText(title)).toBeVisible();
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
});

test('notifies a pending approval with its title only', async ({ page }) => {
  await stubNotifications(page, 'granted', 'granted');
  await enableInSettings(page);
  await send(page, `[aprovar] notificar ${Date.now()}`);
  await expect
    .poll(() => notices(page))
    .toContainEqual(
      expect.objectContaining({
        title: 'Aprovação necessária',
        body: expect.stringContaining('Executar comando de teste'),
      }),
    );
  expect(JSON.stringify(await notices(page))).not.toContain('echo e2e');
  await page.evaluate(() => (window.__background = false));
  await page.getByRole('button', { name: 'Negar', exact: true }).click();
});

test('stays quiet while the window is focused', async ({ page }) => {
  await stubNotifications(page, 'granted', 'granted');
  await enableInSettings(page);
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill(`[normal] em primeiro plano ${Date.now()}`);
  await input.press('Enter');
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  expect(await notices(page)).toEqual([]);
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
});

test('explains a denied permission and keeps the setting off', async ({ page }) => {
  await stubNotifications(page, 'default', 'denied');
  const toggle = await enableInSettings(page);
  await expect(page.getByRole('status').filter({ hasText: 'bloqueadas para este endereço' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});
