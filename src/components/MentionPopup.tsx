import { FileText } from 'lucide-react';
import type { MentionPopupState } from '../hooks/useFileMentions';
import { useI18n } from '../i18n';

/** Splits a path into folder and file name for display. */
function parts(path: string) {
  const slash = path.lastIndexOf('/');
  return { dir: slash >= 0 ? path.slice(0, slash + 1) : '', base: path.slice(slash + 1) };
}

/**
 * Project files suggested while typing `@path` in the composer. Like the saved commands
 * popup, focus stays in the textarea (aria-activedescendant) and options are picked with
 * onMouseDown so it keeps focus. Without a list it shows a short status line instead.
 */
export function MentionPopup({
  id,
  state,
  items,
  activeIndex,
  optionId,
  onSelect,
  onHover,
}: {
  id: string;
  state: MentionPopupState;
  items: string[];
  activeIndex: number;
  optionId: (index: number) => string;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useI18n();
  if (state.kind === 'closed') return null;
  if (state.kind !== 'list')
    return (
      <div className="command-popup mention-popup composer-popover mention-popup-status" role="status">
        {state.kind === 'no-project'
          ? t('mentions.noProject')
          : state.kind === 'loading'
            ? t('mentions.loading')
            : state.kind === 'empty'
              ? t('mentions.empty')
              : t('mentions.error', { message: state.message })}
      </div>
    );
  return (
    <ul id={id} className="command-popup mention-popup composer-popover" role="listbox" aria-label={t('mentions.list')}>
      {items.map((path, index) => {
        const { dir, base } = parts(path);
        return (
          <li
            key={path}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            aria-label={path}
            className={index === activeIndex ? 'active' : undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(path);
            }}
            onMouseEnter={() => onHover(index)}
          >
            <FileText size={13} aria-hidden="true" />
            <span className="mention-popup-path">
              <span className="mention-popup-base">{base}</span>
              {dir && <span className="mention-popup-dir">{dir}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
