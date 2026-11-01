import React, { useEffect, useState } from 'react';

/** One step of a showcase's story: what is on screen, and for how long. */
export interface ShowcaseBeat<Frame> {
    frame: Frame;
    holdMs: number;
}

/**
 * Plays a showcase's timeline on the window it is drawn in, looping until the
 * showcase goes away; a user who asked for less motion gets the stills
 * instead. The timers are the window's own: a popup can be drawn in either
 * main window, and a timer scheduled elsewhere would outlive the one that
 * closes.
 */
export function useShowcaseTimeline<Frame>(
    rootRef: React.RefObject<HTMLElement>,
    timeline: readonly ShowcaseBeat<Frame>[],
    stills: readonly ShowcaseBeat<Frame>[],
): Frame {
    const [frame, setFrame] = useState<Frame>(timeline[0].frame);
    useEffect(() => {
        const win = rootRef.current?.ownerDocument.defaultView;
        if (!win) return;
        const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
        const beats = reducedMotion ? stills : timeline;
        let index = 0;
        let timer: number | null = null;
        const play = () => {
            setFrame(beats[index].frame);
            timer = win.setTimeout(() => {
                index = (index + 1) % beats.length;
                play();
            }, beats[index].holdMs);
        };
        play();
        return () => {
            if (timer !== null) win.clearTimeout(timer);
        };
    }, [rootRef, timeline, stills]);
    return frame;
}
