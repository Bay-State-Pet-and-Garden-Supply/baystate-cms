import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerCommandDescriptor } from '../../store-manager-api';
import {
  filterStoreManagerCommands,
  findStoreManagerCommand,
  argumentCompletions,
  commandNeedsArgument,
  prefillCommand,
  isCommandInput,
} from '../../store-manager-command-logic';

interface CommandPaletteProps {
  input: string;
  commands: StoreManagerCommandDescriptor[];
  /** Command execution is ALWAYS delegated to the parent/server — never local. */
  onExecute: (raw: string) => void;
  /** Prefill the input with "/command " for argument entry. */
  onPrefill: (raw: string) => void;
}

/**
 * Keyboard-driven slash-command palette. Suggestions come exclusively from
 * the server-provided descriptors; argument completions are server-sourced
 * too. The component never executes anything itself.
 */
export function CommandPalette({ input, commands, onExecute, onPrefill }: CommandPaletteProps) {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const visible = isCommandInput(input) && commands.length > 0;

  const matches = useMemo(() => filterStoreManagerCommands(commands, input), [commands, input]);
  const activeCommand = useMemo(
    () => findStoreManagerCommand(commands, input.split(/\s+/)[0] ?? ''),
    [commands, input],
  );
  const suggestions = useMemo(
    () => (activeCommand ? argumentCompletions(activeCommand, input) : []),
    [activeCommand, input],
  );

  // Determine which list is showing: argument completions vs command matches.
  const showingCompletions = suggestions.length > 0;
  const listLength = showingCompletions ? suggestions.length : matches.length;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [input, commands]);

  const runAction = useCallback(
    (index: number) => {
      if (showingCompletions) {
        const suggestion = suggestions[index];
        if (!suggestion) return;
        const token = input.trim().split(/\s+/)[0] ?? '';
        onPrefill(`${token} ${suggestion}`);
        return;
      }
      const command = matches[index];
      if (!command) return;
      if (commandNeedsArgument(command)) {
        onPrefill(prefillCommand(command));
      } else {
        onExecute(`/${command.name}`);
      }
    },
    [showingCompletions, suggestions, matches, input, onExecute, onPrefill],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!visible || listLength === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % listLength);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => (i - 1 + listLength) % listLength);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAction(highlightedIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onPrefill('');
    }
  };

  if (!visible || listLength === 0) return null;

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Store Manager commands"
      className="store-manager-command-palette"
      onKeyDown={handleKeyDown}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: '16px',
        right: '16px',
        zIndex: 40,
        margin: 0,
        padding: '6px',
        listStyle: 'none',
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        maxHeight: '280px',
        overflowY: 'auto',
        fontFamily: fonts.body,
      }}
    >
      {showingCompletions
        ? suggestions.map((s, i) => (
            <li key={s} role="option" aria-selected={i === highlightedIndex}>
              <button
                type="button"
                onMouseEnter={() => setHighlightedIndex(i)}
                onClick={() => runAction(i)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: rounded.sm,
                  background: i === highlightedIndex ? colors.feedBagCream : 'transparent',
                  color: colors.ledgerCharcoal,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                <span style={{ fontWeight: 700 }}>{s}</span>
                <span style={{ color: colors.mulchBrown, fontSize: 11, marginLeft: 8 }}>
                  {activeCommand?.argSpecs[0]?.label}
                </span>
              </button>
            </li>
          ))
        : matches.map((command, i) => (
            <li key={command.name} role="option" aria-selected={i === highlightedIndex}>
              <button
                type="button"
                onMouseEnter={() => setHighlightedIndex(i)}
                onClick={() => runAction(i)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: rounded.sm,
                  background: i === highlightedIndex ? colors.feedBagCream : 'transparent',
                  color: colors.ledgerCharcoal,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  /{command.name}
                  {command.aliases.length > 0 && (
                    <span style={{ color: colors.mulchBrown, fontWeight: 500, marginLeft: 8, fontSize: 11 }}>
                      {command.aliases.map((a) => `/${a}`).join(' ')}
                    </span>
                  )}
                </div>
                <div style={{ color: colors.mulchBrown, fontSize: 11, marginTop: 2 }}>{command.description}</div>
              </button>
            </li>
          ))}
    </ul>
  );
}
