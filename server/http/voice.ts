import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { MAX_VOICE_BYTES, voiceMime } from '../../shared/voice.js';
import { parseBody } from '../../shared/schemas.js';
import { sniffAudio, VoiceError, voiceStatusIn, type VoiceService } from '../voice.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

const TRANSCRIBE_PATH = /^\/api\/transcribe\/?$/;
/** Like attachment uploads, this route parses its own larger JSON body after the access guard. */
export const isVoiceUpload = (req: Request) => req.method === 'POST' && TRANSCRIBE_PATH.test(req.path);

const MAX_BASE64 = Math.ceil(MAX_VOICE_BYTES / 3) * 4;
// Base64 plus the small JSON envelope; the decoded size is checked again below.
const voiceJson = express.json({ limit: MAX_BASE64 + 1024, strict: true });
function parseVoice(req: Request, res: Response, next: NextFunction) {
  voiceJson(req, res, (e?: unknown) => {
    if ((e as { type?: string } | undefined)?.type === 'entity.too.large') return error(res, 413, 'voice.tooLarge');
    if (e) return error(res, 400, 'common.invalidJson');
    next();
  });
}

const TranscribeSchema = z.object({
  mime: z.string().max(100),
  data: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});

/** GET /api/transcribe/status and POST /api/transcribe (docs/specs/voice.md). */
export function voiceRoutes({ store }: BackendContext, voice: VoiceService) {
  const app = Router();
  app.get('/api/transcribe/status', async (req, res) => {
    res.json(voiceStatusIn(await voice.status(), req.locale));
  });
  app.post('/api/transcribe', parseVoice, async (req, res) => {
    if (store.getSettings()?.voiceDictation === false) return error(res, 403, 'voice.disabled');
    const parsed = parseBody(TranscribeSchema, req.body, 'voice.badBody', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const mime = voiceMime(parsed.data.mime);
    if (!mime) return error(res, 415, 'voice.badMime');
    if (parsed.data.data.length > MAX_BASE64) return error(res, 413, 'voice.tooLarge');
    const audio = Buffer.from(parsed.data.data, 'base64');
    if (!audio.byteLength) return error(res, 400, 'voice.empty');
    if (audio.byteLength > MAX_VOICE_BYTES) return error(res, 413, 'voice.tooLarge');
    if (!sniffAudio(audio, mime)) return error(res, 415, 'voice.notAudio');
    // Stops ffmpeg/voxtype when the client goes away before the answer.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      res.json(await voice.transcribe(audio, mime, abort.signal));
    } catch (e) {
      if (abort.signal.aborted) return;
      if (e instanceof VoiceError) return error(res, e.status, e);
      error(res, 500, 'voice.unexpected');
    }
  });
  return app;
}
