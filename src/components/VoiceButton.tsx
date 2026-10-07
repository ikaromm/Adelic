import { LoaderCircle, Mic, Square } from 'lucide-react';
import { formatElapsed, MAX_VOICE_SECONDS } from '../../shared/voice';
import type { DictationState } from '../hooks/useVoiceDictation';

/**
 * Composer microphone (docs/specs/voice.md): click to record, click again (or Esc) to stop
 * and transcribe locally. While recording it shows the elapsed time and the input level.
 */
export function VoiceButton({
  state,
  elapsed,
  level,
  blocker,
  disabled,
  onToggle,
}: {
  state: DictationState;
  elapsed: number;
  level: number;
  blocker?: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  if (state === 'recording') {
    const label = `Parar gravação e transcrever (${formatElapsed(elapsed)} de ${formatElapsed(MAX_VOICE_SECONDS)})`;
    return (
      <button
        type="button"
        className="composer-pill voice-button is-recording"
        aria-label={label}
        title="Parar e transcrever (Esc)"
        onClick={onToggle}
      >
        <Square size={11} fill="currentColor" aria-hidden="true" />
        <span className="voice-level" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0.06, level).toFixed(2)})` }} />
        </span>
        <span className="voice-time" aria-hidden="true">
          {formatElapsed(elapsed)}
        </span>
      </button>
    );
  }
  if (state === 'transcribing')
    return (
      <button type="button" className="composer-pill voice-button" aria-label="Transcrevendo o áudio…" disabled>
        <LoaderCircle className="spin" size={15} aria-hidden="true" />
        <span className="composer-pill-label">Transcrevendo…</span>
      </button>
    );
  // Unavailable stays focusable (aria-disabled) so the reason shows as a tooltip and, on
  // click, as a notice; a busy composer disables it for real.
  return (
    <button
      type="button"
      className="composer-pill voice-button"
      aria-label={blocker ? `Ditar por voz (${blocker})` : 'Ditar por voz'}
      aria-disabled={blocker ? true : undefined}
      title={blocker ?? 'Ditar por voz (transcrição local)'}
      disabled={disabled}
      onClick={onToggle}
    >
      <Mic size={15} aria-hidden="true" />
    </button>
  );
}
