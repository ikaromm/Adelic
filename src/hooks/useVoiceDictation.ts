import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_VOICE_SECONDS,
  VOICE_INSECURE_CONTEXT,
  VOICE_MIMES,
  voiceMime,
  type VoiceStatus,
} from '../../shared/voice';
import { api } from '../api';

export type DictationState = 'idle' | 'recording' | 'transcribing';

/** Why the microphone button cannot be used right now, or undefined when it can. */
export function dictationBlocker(
  status: VoiceStatus | undefined,
  env: { secure: boolean; media: boolean; recorder: boolean },
): string | undefined {
  if (!status) return 'Verificando o ditado por voz…';
  if (!status.available) return status.reason || 'Ditado indisponível';
  if (!env.secure) return VOICE_INSECURE_CONTEXT;
  if (!env.media || !env.recorder) return 'Este navegador não permite gravar áudio';
  return undefined;
}

/** First container this browser can record that the server accepts (opus in webm first). */
export function recorderMime(isSupported: (mime: string) => boolean) {
  const preferred = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', ...VOICE_MIMES];
  return preferred.find((mime) => isSupported(mime));
}

function browserEnv() {
  if (typeof window === 'undefined') return { secure: false, media: false, recorder: false };
  return {
    secure: window.isSecureContext,
    media: typeof navigator.mediaDevices?.getUserMedia === 'function',
    recorder: typeof window.MediaRecorder === 'function',
  };
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Não foi possível ler o áudio gravado.'));
    reader.readAsDataURL(blob);
  });
}

function micError(e: unknown) {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'O acesso ao microfone foi negado. Libere-o nas permissões e tente de novo.';
  if (name === 'NotFoundError') return 'Nenhum microfone encontrado.';
  return `Não foi possível usar o microfone: ${(e as Error)?.message || 'erro desconhecido'}`;
}

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  audio?: AudioContext;
  timer: number;
  startedAt: number;
  chunks: Blob[];
}

/**
 * Microphone dictation for the composer (docs/specs/voice.md): records with MediaRecorder,
 * uploads to /api/transcribe and hands the text to `onText`. One recording at a time, up to
 * MAX_VOICE_SECONDS; leaving the page stops the microphone without transcribing.
 */
export function useVoiceDictation({
  enabled,
  onText,
  onError,
}: {
  enabled: boolean;
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus>();
  const [state, setState] = useState<DictationState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const recording = useRef<Recording | undefined>(undefined);
  const upload = useRef<AbortController | undefined>(undefined);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const refreshStatus = useCallback(() => {
    api
      .voiceStatus()
      .then(setStatus)
      .catch((e: Error) => setStatus({ available: false, reason: `Ditado indisponível: ${e.message}` }));
  }, []);
  useEffect(() => {
    if (enabled) refreshStatus();
  }, [enabled, refreshStatus]);

  const release = useCallback((rec: Recording) => {
    window.clearInterval(rec.timer);
    for (const track of rec.stream.getTracks()) track.stop();
    void rec.audio?.close().catch(() => undefined);
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    const rec = recording.current;
    if (!rec || rec.recorder.state === 'inactive') return;
    rec.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (recording.current || upload.current) return;
    const blocked = dictationBlocker(status, browserEnv());
    if (blocked) return callbacks.current.onError(blocked);
    const mime = recorderMime((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return callbacks.current.onError('Este navegador não grava áudio em um formato aceito.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      return callbacks.current.onError(micError(e));
    }
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const rec: Recording = { recorder, stream, timer: 0, startedAt: Date.now(), chunks: [] };
    // Level meter: best effort, recording works without it.
    let sample: (() => number) | undefined;
    try {
      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      audio.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      rec.audio = audio;
      sample = () => {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128));
        return Math.min(1, peak / 64);
      };
    } catch {
      sample = undefined;
    }
    recorder.ondataavailable = (event) => {
      if (event.data.size) rec.chunks.push(event.data);
    };
    recorder.onstop = () => {
      release(rec);
      recording.current = undefined;
      const type = voiceMime(recorder.mimeType || mime) ?? voiceMime(mime)!;
      const blob = new Blob(rec.chunks, { type });
      if (!blob.size) {
        setState('idle');
        return callbacks.current.onError('Nenhum áudio foi gravado.');
      }
      setState('transcribing');
      const controller = new AbortController();
      upload.current = controller;
      blobBase64(blob)
        .then((data) => api.transcribe({ mime: type, data }, controller.signal))
        .then(({ text }) => {
          if (text.trim()) callbacks.current.onText(text.trim());
          else callbacks.current.onError('Nenhuma fala reconhecida no áudio.');
        })
        .catch((e: Error) => {
          if (!controller.signal.aborted) callbacks.current.onError(e.message);
        })
        .finally(() => {
          if (upload.current === controller) upload.current = undefined;
          setState('idle');
        });
    };
    rec.timer = window.setInterval(() => {
      const seconds = (Date.now() - rec.startedAt) / 1000;
      setElapsed(seconds);
      if (sample) setLevel(sample());
      if (seconds >= MAX_VOICE_SECONDS) stop();
    }, 100);
    recording.current = rec;
    setElapsed(0);
    setState('recording');
    recorder.start(1000);
  }, [status, release, stop]);

  // Unmount: free the microphone and drop any pending upload.
  useEffect(
    () => () => {
      const rec = recording.current;
      if (rec) {
        rec.recorder.onstop = null;
        if (rec.recorder.state !== 'inactive') rec.recorder.stop();
        release(rec);
      }
      upload.current?.abort();
    },
    [release],
  );
  // Esc stops the recording from anywhere, before popups or dialogs react to it.
  useEffect(() => {
    if (state !== 'recording') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, stop]);
  // Turning the setting off mid-recording stops the microphone.
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);

  const blocker = dictationBlocker(status, browserEnv());
  return {
    state,
    elapsed,
    level,
    status,
    /** Why the button is disabled (also its tooltip), when it is. */
    blocker,
    refreshStatus,
    toggle: () => (state === 'recording' ? stop() : state === 'idle' ? void start() : undefined),
    stop,
  };
}
