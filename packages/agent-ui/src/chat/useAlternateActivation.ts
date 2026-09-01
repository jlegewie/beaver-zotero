import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * Tracks whether the alternate-activation modifier is held while the pointer is
 * over an element.
 *
 * A citation names two things at once: the passage it cites and the work the
 * passage comes from. The default hover/click acts on the passage; holding the
 * modifier acts on the work. The hover preview and the click handler both need
 * to agree on which one is currently selected, so the state lives here.
 *
 * Shift is the modifier because it is the only one that is inert on its own in
 * every host: a bare Alt keydown activates Gecko's menu bar on Windows and
 * Linux, and Ctrl-click is the context-menu gesture on macOS — either would
 * fire while the user is merely hovering.
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

        const sync = (event: KeyboardEvent) => setIsAlternate(event.shiftKey);
        const clear = () => setIsAlternate(false);

        // Capture phase: a citation can render inside surfaces that stop key
        // events on their way up (the composer, the reader).
        hoveredDocument.addEventListener('keydown', sync, true);
        hoveredDocument.addEventListener('keyup', sync, true);
        // Focus can leave the window while the key is still down, in which case
        // the keyup is delivered elsewhere and the state would stay stuck on.
        const win = hoveredDocument.defaultView;
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
                // The modifier may already be held when the pointer arrives.
                setIsAlternate(event.shiftKey);
                setHoveredDocument(event.currentTarget.ownerDocument);
            },
            onMouseLeave: () => {
                setIsAlternate(false);
                setHoveredDocument(null);
            },
        },
    };
}
