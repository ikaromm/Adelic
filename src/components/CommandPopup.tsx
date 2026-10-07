import { Command } from 'lucide-react';
import type { CommandEntry } from '../../shared/commands';

const sourceLabel: Record<CommandEntry['source'], string> = {
  builtin: 'embutido',
  global: 'global',
  repo: 'do repositório',
  project: 'do projeto',
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
  return (
    <ul id={id} className="command-popup composer-popover" role="listbox" aria-label="Comandos salvos">
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
              <small>{sourceLabel[command.source]}</small>
            </span>
            {command.description && <span className="command-popup-description">{command.description}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
