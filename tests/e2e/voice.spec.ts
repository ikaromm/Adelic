import { expect, test, type Page } from './fixtures';

// Local voice dictation (docs/specs/voice.md). The microphone and MediaRecorder are replaced
// by stubs in the page, and the E2E server's fake voxtype (tests/e2e/server.ts) transcribes
// every recording as "texto ditado"; no real audio, ffmpeg or voxtype is involved.

declare global {
  interface Window {
    __micRequests: MediaStreamConstraints[];
  }
}

async function stubMicrophone(page: Page) {
  await page.addInitScript(() => {
    window.__micRequests = [];
    const track = { stop() {}, kind: 'audio' };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          window.__micRequests.push(constraints);
          return stream;
        },
      },
    });
    class FakeRecorder {
      static isTypeSupported(mime: string) {
        return mime.startsWith('audio/webm');
      }
      state: 'inactive' | 'recording' = 'inactive';
      mimeType: string;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream, options: { mimeType: string }) {
        this.mimeType = options.mimeType;
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        // A WebM (EBML) header, so the server's signature check accepts it.
        const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
        this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
        setTimeout(() => this.onstop?.(), 0);
      }
    }
    class FakeAudioContext {
      createAnalyser() {
        return {
          fftSize: 256,
          getByteTimeDomainData(buffer: Uint8Array) {
            buffer.fill(128);
            buffer[0] = 180;
          },
        };
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      async close() {}
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
  });
}

async function voiceMode(page: Page, mode: 'local' | 'remote' | 'missing') {
  const res = await page.request.get(`/e2e/voice?mode=${mode}`);
  expect(res.ok()).toBe(true);
}

async function newConversation(page: Page) {
  await page.goto('/');
  // The sidebar's "Nova conversa" is hidden on small screens; the welcome button is always there.
  await page.getByRole('button', { name: 'Começar uma conversa' }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return input;
}

test.beforeEach(async ({ page }) => {
  await stubMicrophone(page);
  await voiceMode(page, 'local');
});
test.afterEach(async ({ page }) => {
  await voiceMode(page, 'local');
});

test('dictates into the composer at the caret without sending', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('antes depois');
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));

  await page.getByRole('button', { name: 'Ditar por voz', exact: true }).click();
  const stop = page.getByRole('button', { name: /Parar gravação e transcrever \(0:0\d de 2:00\)/ });
  await expect(stop).toBeVisible();
  await expect(page.locator('.voice-time')).toHaveText(/0:0\d/);
  expect(await page.evaluate(() => window.__micRequests)).toEqual([{ audio: true, video: false }]);

  await stop.click();
  await expect(input).toHaveValue('antes texto ditado depois');
  // Focus and caret right after the inserted text; nothing was sent.
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe('antes texto ditado'.length);
  await expect(page.locator('.message-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ditar por voz', exact: true })).toBeEnabled();
});

test('Esc stops the recording and transcribes', async ({ page }) => {
  const input = await newConversation(page);
  await page.getByRole('button', { name: 'Ditar por voz', exact: true }).click();
  await expect(page.getByRole('button', { name: /Parar gravação/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Parar gravação/ })).toHaveCount(0);
  await expect(input).toHaveValue('texto ditado');
});

test('shows the button as unavailable with the reason', async ({ page }) => {
  await voiceMode(page, 'remote');
  await newConversation(page);
  const button = page.getByRole('button', { name: /^Ditar por voz \(/ });
  const reason = 'Ditado indisponível: o voxtype está configurado para um serviço remoto';
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAttribute('title', reason);
  // aria-disabled keeps it focusable; a click explains instead of opening the microphone.
  await button.dispatchEvent('click');
  await expect(page.getByRole('alert')).toContainText(reason);
  expect(await page.evaluate(() => window.__micRequests)).toEqual([]);

  await voiceMode(page, 'missing');
  await newConversation(page);
  await expect(page.getByRole('button', { name: /^Ditar por voz \(/ })).toHaveAttribute(
    'title',
    /voxtype não encontrado/,
  );
});

test('the setting hides the microphone', async ({ page }) => {
  await newConversation(page);
  await expect(page.getByRole('button', { name: 'Ditar por voz', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Ditado por voz' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Disponível: whisper · base, neste computador.')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  try {
    await newConversation(page);
    await expect(page.getByRole('button', { name: /Ditar por voz/ })).toHaveCount(0);
  } finally {
    await page.request.patch('/api/settings', { data: { voiceDictation: true } });
  }
});

test('fits the composer at 360px while recording', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const input = await newConversation(page);
  await page.getByRole('button', { name: 'Ditar por voz', exact: true }).click();
  const stop = page.getByRole('button', { name: /Parar gravação/ });
  await expect(stop).toBeVisible();
  const box = await stop.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const fontSize = await page.locator('.voice-time').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(11);
  await stop.click();
  await expect(input).toHaveValue('texto ditado');
});
