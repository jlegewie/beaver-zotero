import { useCallback, useEffect, useRef, useState } from 'react';
import {
    isCapped,
    nextDeadline,
    remainingFraction,
} from '@beaver/agent-core/run-state/askUserQuestionCountdown';

/** How often the drained share is re-read for the bar. */
const TICK_MS = 250;

export interface QuestionCountdown {
    /** Refill the idle window; call on every interaction with the card. */
    touch: () => void;
    /** Share of the idle window left, 0..1. */
    fraction: number;
    /** Milliseconds until the card expires. */
    remainingMs: number;
    /** Touching no longer extends the deadline: the backend's window is closing. */
    capped: boolean;
}

/**
 * Drives the question card's idle countdown from the wall clock.
 *
 * The deadline refills on `touch()` up to the backend's window ending at
 * `expiresAt`. `onExpire` fires once when the deadline passes, unless the
 * hook has been disabled first (the card has already been answered). The
 * callback is read through a ref so the timer always sees the latest draft
 * without being rescheduled on every render.
 */
export function useQuestionCountdown(
    expiresAt: number,
    onExpire: () => void,
    enabled: boolean,
): QuestionCountdown {
    const [deadline, setDeadline] = useState(() => nextDeadline(expiresAt, Date.now()));
    const [now, setNow] = useState(() => Date.now());
    const onExpireRef = useRef(onExpire);
    onExpireRef.current = onExpire;

    const touch = useCallback(() => {
        setDeadline(nextDeadline(expiresAt, Date.now()));
    }, [expiresAt]);

    useEffect(() => {
        if (!enabled) return;
        const tick = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(tick);
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;
        const timer = setTimeout(() => onExpireRef.current(), Math.max(0, deadline - Date.now()));
        return () => clearTimeout(timer);
    }, [deadline, enabled]);

    return {
        touch,
        fraction: remainingFraction(deadline, now),
        remainingMs: Math.max(0, deadline - now),
        capped: isCapped(expiresAt, now),
    };
}
