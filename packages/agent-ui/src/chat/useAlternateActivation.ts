import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { isMacPlatform } from '../utils/platform';

/**
 * Whether an event carries the alternate-activation modifier: the platform
 * accelerator, Cmd on macOS and Ctrl everywhere else.
 *
 * It has to be the accelerator rather than Shift or Alt, because a citation sits
 * inside selectable prose in a chrome document:
 *
 * - Shift-click extends the text selection. That happens on *mousedown*, so a
 *   `preventDefault()` on the click cannot undo it — the user gets a selection
 *   and an activation at once.
 * - A bare Alt keydown activates Gecko's menu bar on Windows and Linux, which
 *   would fire while the user is merely hovering.
 *
 * Neither accelerator chord has a default action over a plain `<span>`, and
 * mapping macOS to Cmd keeps Ctrl-click free for the context menu there.
 *
 * @param navigator - The navigator of the window the event was delivered to
 */
export function hasAlternateModifier(
    event: { metaKey: boolean; ctrlKey: boolean },
    navigator: Navigator | undefined | null,
): boolean {
    return navigator && isMacPlatform(navigator) ? event.metaKey : event.ctrlKey;
}

/**
 * Tracks whether the alternate-activation modifier is held while the pointer is
 * over an element.
 *
 * A citation names two things at once: the passage it cites and the work the
 * passage comes from. The default hover/click acts on the passage; holding the
 * modifier acts on the work. The hover preview and the click handler both need
 * to agree on which one is currently selected, so the state lives here.
 *
 * See {@link hasAlternateModifier} for which key that is and why.
 *
 * Key listeners are attached only while hovering, and on the document the
 * pointer actually entered, so a citation rendered in a second window tracks
 * that window's keyboard rather than another one's.
 */
export interface AlternateActivation {
    /** Whether the modifier is currently held over the tracked element. */
    isAlternate: boolean;
    /** Spread onto the element whose hover should be tracked. */
    hoverProps: {
        onMouseEnter: (event: ReactMouseEvent) => void;
        onMouseLeave: () => void;
    };
}

export function useAlternateActivation(): AlternateActivation {
    const [hoveredDocument, setHoveredDocument] = useState<Document | null>(null);
    const [isAlternate, setIsAlternate] = useState(false);

    useEffect(() => {
        if (!hoveredDocument) return;

        const win = hoveredDocument.defaultView;
        const sync = (event: KeyboardEvent) => setIsAlternate(hasAlternateModifier(event, win?.navigator));
        const clear = () => setIsAlternate(false);

        // Capture phase: a citation can render inside surfaces that stop key
        // events on their way up (the composer, the reader).
        hoveredDocument.addEventListener('keydown', sync, true);
        hoveredDocument.addEventListener('keyup', sync, true);
        // Focus can leave the window while the key is still down, in which case
        // the keyup is delivered elsewhere and the state would stay stuck on.
        // On macOS that includes Cmd-Tab, which is exactly this chord.
        win?.addEventListener('blur', clear);

        return () => {
            hoveredDocument.removeEventListener('keydown', sync, true);
            hoveredDocument.removeEventListener('keyup', sync, true);
            win?.removeEventListener('blur', clear);
        };
    }, [hoveredDocument]);

    return {
        isAlternate,
        hoverProps: {
            onMouseEnter: (event: ReactMouseEvent) => {
                const doc = event.currentTarget.ownerDocument;
                // The modifier may already be held when the pointer arrives.
                setIsAlternate(hasAlternateModifier(event, doc.defaultView?.navigator));
                setHoveredDocument(doc);
            },
            onMouseLeave: () => {
                setIsAlternate(false);
                setHoveredDocument(null);
            },
        },
    };
}
