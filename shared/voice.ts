// Local voice dictation (docs/specs/voice.md): limits, messages and helpers shared by the
// composer and the server. Audio is transcribed on this machine by voxtype, never elsewhere.

/** Longest recording the composer makes before stopping on its own. */
export const MAX_VOICE_SECONDS = 120;
/** Largest decoded audio upload accepted by POST /api/transcribe. */
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
/** Containers MediaRecorder produces (Chromium/Electron: webm, Firefox: ogg, Safari: mp4). */
export const VOICE_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4'] as const;
export type VoiceMime = (typeof VOICE_MIMES)[number];

export const VOICE_REMOTE_REFUSAL = 'Ditado indisponível: o voxtype está configurado para um serviço remoto';
export const VOICE_INSECURE_CONTEXT = 'O microfone exige HTTPS ou localhost';
export const VOICE_BUSY = 'Outro ditado está sendo transcrito; aguarde ele terminar.';
export const VOICE_TOO_LARGE = 'Áudio grande demais: até 8 MB (cerca de 2 minutos).';
export const VOICE_DISABLED = 'Ditado por voz desativado nas configurações.';

/** Result of GET /api/transcribe/status. `engine`/`model` only describe the local setup. */
export interface VoiceStatus {
  available: boolean;
  reason?: string;
  engine?: string;
  model?: string;
}

/** `audio/webm;codecs=opus` → `audio/webm`; undefined for anything that is not an accepted audio type. */
export function voiceMime(mime: string): VoiceMime | undefined {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return (VOICE_MIMES as readonly string[]).includes(base) ? (base as VoiceMime) : undefined;
}

/** `m:ss` for the recording timer. */
export function formatElapsed(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Inserts dictated text into `value` over the selection [start, end), adding a space on each
 * side only where the neighbour is not already whitespace. Returns the new value and caret.
 */
export function insertDictation(value: string, start: number, end: number, text: string) {
  const clean = text.trim();
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  if (!clean) return { value, caret: to };
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const inserted = `${lead}${clean}${trail}`;
  return { value: before + inserted + after, caret: from + lead.length + clean.length };
}
