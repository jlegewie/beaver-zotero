import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Mount and open state for content that slides in when `visible` turns on and
 * slides out when it turns off. Pair it with the `.slide-presence` styles:
 * `present` says whether to render the content, `open` goes on the slot as
 * `data-open`, and `onTransitionEnd` goes on the slot so the content unmounts
 * once it has slid out. Content that is visible on first render shows without
 * sliding in.
 */
export function useSlidePresence<T extends HTMLElement>(visible: boolean) {
    const ref = useRef<T>(null);
    // Whether the slot has opened since it last finished closing.
    const [opened, setOpened] = useState(visible);

    useLayoutEffect(() => {
        if (!visible || opened) return;
        // Lay out the closed state first, so opening transitions from it.
        ref.current?.getBoundingClientRect();
        setOpened(true);
    }, [visible, opened]);

    const onTransitionEnd = (event: React.TransitionEvent<T>) => {
        if (event.target === event.currentTarget && !visible) setOpened(false);
    };

    return { ref, present: visible || opened, open: visible && opened, onTransitionEnd };
}
