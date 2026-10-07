// Run activity events in the UI's locale (docs/i18n.md, "Run activity events"). Events created
// since the server i18n carry `textKey` + `textVars` (shared/event-text.ts); older events, and
// keys this build does not know, show their persisted `text` unchanged.
//
//   import { eventText } from '../i18n/eventText';
//   <span>{eventText(event)}</span>          // current locale
//   eventText(event, 'en')                   // a fixed locale
import type { RunEvent } from '../../shared/contracts';
import { eventText as translateEvent, isEventTextKey, type EventVars } from '../../shared/event-text';
import type { Locale } from '../../shared/i18n';
import { getLocale } from './store';

/** The event's text in `locale` (default: the current UI locale), or its stored `text`. */
export function eventText(
  event: Pick<RunEvent, 'text' | 'textKey' | 'textVars'>,
  locale: Locale = getLocale(),
): string {
  const { textKey, textVars } = event;
  if (!isEventTextKey(textKey) || !validVars(textVars)) return event.text;
  return translateEvent(textKey, textVars, locale);
}

/** Nested keys must be known too, or the stored text is safer than a half-translated sentence. */
function validVars(vars: RunEvent['textVars']): vars is EventVars | undefined {
  if (vars === undefined) return true;
  if (typeof vars !== 'object' || vars === null) return false;
  return Object.values(vars).every(
    (value) =>
      typeof value === 'string' ||
      typeof value === 'number' ||
      (typeof value === 'object' && value !== null && isEventTextKey(value.key)),
  );
}
