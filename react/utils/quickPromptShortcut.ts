/**
 * The quick prompt chord as the user should read it: Cmd+Option+<key> on
 * macOS, Ctrl+Alt+<key> elsewhere, with the key the user configured for
 * Beaver's shortcuts. The chord itself is matched in `src/utils/shortcuts.ts`;
 * this is its display form, shared by everything that names it.
 */
import { getPref } from '../../src/utils/prefs';

function shortcutKey(): string {
    return (getPref('keyboardShortcut') || 'j').toUpperCase();
}

/** The chord key by key, for drawing keycaps. */
export function quickPromptShortcutKeys(): string[] {
    const key = shortcutKey();
    return Zotero.isMac ? ['⌘', '⌥', key] : ['Ctrl', 'Alt', key];
}

/** The chord as one piece of text. */
export function quickPromptShortcutLabel(): string {
    const key = shortcutKey();
    return Zotero.isMac ? `⌘⌥${key}` : `Ctrl+Alt+${key}`;
}
