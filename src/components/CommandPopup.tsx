import { Command } from 'lucide-react';
import type { CommandEntry } from '../../shared/commands';
import { useI18n, type MessageKey } from '../i18n';

const sourceLabel: Record<CommandEntry['source'], MessageKey> = {
  builtin: 'slash.source.builtin',
  global: 'slash.source.global',
  repo: 'slash.source.repo',
  project: 'slash.source.project',
};

/**
 * Listbox of saved commands shown above the composer while the message is `/prefix`.
 * Focus stays in the composer (aria-activedescendant); options are picked with the mouse
 * via onMouseDown so the textarea keeps focus.
 */
export function CommandPopup({
  id,
  items,
  activeIndex,
  optionId,
  onSelect,
  onHover,
}: {
  id: string;
  items: CommandEntry[];
  activeIndex: number;
  optionId: (index: number) => string;
  onSelect: (command: CommandEntry) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useI18n();
  return (
    <ul id={id} className="command-popup composer-popover" role="listbox" aria-label={t('slash.list')}>
      {items.map((command, index) => (
        <li
          key={command.id}
          id={optionId(index)}
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? 'active' : undefined}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(command);
          }}
          onMouseEnter={() => onHover(index)}
        >
          <Command size={13} aria-hidden="true" />
          <span className="command-popup-text">
            <span className="command-popup-name">
              /{command.name}
              <small>{t(sourceLabel[command.source])}</small>
            </span>
            {command.description && <span className="command-popup-description">{command.description}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
