/**
 * Keyboard chord matching for Beaver's shortcuts. Pure, so the platform and
 * the configured key are parameters rather than globals.
 */

/** The parts of a keyboard event a chord is decided from. */
export interface ChordEvent {
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    getModifierState?: (key: string) => boolean;
}

/**
 * Whether the event is the quick prompt chord: Cmd+Option+<key> on macOS,
 * Ctrl+Alt+<key> elsewhere.
 *
 * The configured key is matched by the character typed or by the physical
 * key. On macOS, Option changes the character (Option+J is "∆") and Gecko also
 * reports the AltGraph state for it, so there the physical key decides and the
 * state is ignored. On Windows and Linux, AltGr arrives as Ctrl+Alt with the
 * AltGraph state, and on layouts that use it the same physical key types a
 * character (AltGr+Q is "@" on a German keyboard). Under that state only the
 * typed character may match: a key that produced another character is text
 * entry, and taking it would swallow the character.
 */
export function isQuickPromptShortcut(event: ChordEvent, shortcutKey: string, isMac: boolean): boolean {
    const key = shortcutKey.toLowerCase();
    const typedKeyMatches = event.key.toLowerCase() === key;
    const physicalKeyMatches = event.code.toLowerCase() === `key${key}`;
    if (isMac) {
        return (typedKeyMatches || physicalKeyMatches)
            && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey;
    }
    const altGraph = event.getModifierState?.('AltGraph') ?? false;
    const keyMatches = typedKeyMatches || (!altGraph && physicalKeyMatches);
    return keyMatches && event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey;
}
