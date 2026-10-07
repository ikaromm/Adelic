import { LoaderCircle, Mic, Square } from 'lucide-react';
import { formatElapsed, MAX_VOICE_SECONDS } from '../../shared/voice';
import type { DictationState } from '../hooks/useVoiceDictation';
import { useI18n } from '../i18n';

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
  const { t } = useI18n();
  if (state === 'recording') {
    const label = t('voice.stopLabel', { elapsed: formatElapsed(elapsed), max: formatElapsed(MAX_VOICE_SECONDS) });
    return (
      <button
        type="button"
        className="composer-pill voice-button is-recording"
        aria-label={label}
        title={t('voice.stopTitle')}
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
      <button type="button" className="composer-pill voice-button" aria-label={t('voice.transcribingLabel')} disabled>
        <LoaderCircle className="spin" size={15} aria-hidden="true" />
        <span className="composer-pill-label">{t('voice.transcribing')}</span>
      </button>
    );
  // Unavailable stays focusable (aria-disabled) so the reason shows as a tooltip and, on
  // click, as a notice; a busy composer disables it for real.
  return (
    <button
      type="button"
      className="composer-pill voice-button"
      aria-label={blocker ? t('voice.dictateBlocked', { reason: blocker }) : t('voice.dictate')}
      aria-disabled={blocker ? true : undefined}
      title={blocker ?? t('voice.dictateTitle')}
      disabled={disabled}
      onClick={onToggle}
    >
      <Mic size={15} aria-hidden="true" />
    </button>
  );
}
