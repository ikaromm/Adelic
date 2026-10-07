import { expect, test, type Page } from './fixtures';

// Attachments end to end: picker, drag-and-drop, limits, upload, the run receiving the files
// (the scripted provider echoes what it got) and the sent message showing them.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function newConversation(page: Page) {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return input;
}

test('attaches an image and a text file, sends them and shows them in the message', async ({ page }) => {
  const input = await newConversation(page);
  await expect(page.getByRole('button', { name: 'Anexar arquivos ou imagens' })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'tela.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notas.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notas\nconteúdo do anexo\n') },
  ]);
  const pending = page.getByRole('list', { name: 'Anexos da mensagem' });
  await expect(pending.getByRole('listitem')).toHaveCount(2);
  await expect(pending.getByText('Enviando…')).toHaveCount(0);
  await expect(pending.getByText('notas.md')).toBeVisible();

  // Removing works from the keyboard too.
  await page.getByRole('button', { name: 'Remover anexo notas.md' }).focus();
  await page.keyboard.press('Enter');
  await expect(pending.getByRole('listitem')).toHaveCount(1);

  // Drag-and-drop a text file into the composer.
  const drop = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['export const x = 1;\n'], 'codigo.ts', { type: 'text/plain' }));
    return transfer;
  });
  await page.locator('.composer-box').dispatchEvent('dragover', { dataTransfer: drop });
  await page.locator('.composer-box').dispatchEvent('drop', { dataTransfer: drop });
  await expect(pending.getByRole('listitem')).toHaveCount(2);
  await expect(pending.getByText('Enviando…')).toHaveCount(0);

  await input.fill('[anexos] confira os anexos');
  await input.press('Enter');
  await expect(page.locator('.markdown-content', { hasText: 'Imagens recebidas: tela.png' })).toContainText(
    'Arquivos recebidos: codigo.ts',
  );
  await expect(pending).toBeHidden();
  const sent = page.getByRole('list', { name: 'Anexos', exact: true });
  const thumb = sent.getByRole('img', { name: 'tela.png' });
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(sent.getByText('codigo.ts')).toBeVisible();

  // Persisted with the message: still there after a reload.
  await page.reload();
  await page.locator('.session-list').getByText('[anexos] confira os anexos').first().click();
  await expect(page.getByRole('list', { name: 'Anexos', exact: true }).getByText('codigo.ts')).toBeVisible();
});

test('rejects unsupported and oversized files with a clear message', async ({ page }) => {
  await newConversation(page);
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles({ name: 'programa.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
  await expect(page.getByRole('alert')).toContainText('“programa.exe” não é um tipo aceito');
  await page.getByRole('button', { name: 'Dispensar aviso' }).click();
  await picker.setInputFiles({
    name: 'grande.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(512 * 1024 + 1, 'a'),
  });
  await expect(page.getByRole('alert')).toContainText('passa de 512 KB');
  await expect(page.getByRole('list', { name: 'Anexos da mensagem' })).toBeHidden();
});

test('limits a message to five attachments', async ({ page }) => {
  await newConversation(page);
  const files = Array.from({ length: 6 }, (_, i) => ({
    name: `arquivo-${i}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`texto ${i}`),
  }));
  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByRole('alert')).toContainText('até 5 anexos');
  await expect(page.getByRole('list', { name: 'Anexos da mensagem' }).getByRole('listitem')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Limite de 5 anexos por mensagem' })).toBeDisabled();
});
