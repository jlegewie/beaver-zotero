/**
 * True when a keyboard event is owned by an active IME composition.
 *
 * Custom key handling (submit-on-Enter, caret navigation, menu keys) must
 * yield to the IME while it composes: acting on these events — or calling
 * preventDefault() / moving the selection in response to them — can cancel
 * the composition or discard the text the user just committed (Gecko commits
 * a composition whenever script changes the selection mid-compose).
 *
 * `isComposing` is the standard signal; keyCode 229 is the legacy convention
 * browsers use for keydown events consumed by an IME. Both are checked
 * because either can be present alone depending on platform and IME.
 *
 * Accepts native KeyboardEvents; for React synthetic events pass
 * `e.nativeEvent` (the synthetic type does not expose `isComposing`).
 */
export function isImeKeyEvent(event: { isComposing?: boolean; keyCode?: number }): boolean {
    return event.isComposing === true || event.keyCode === 229;
}
