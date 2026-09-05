/**
 * The question card's idle-countdown arithmetic: refill on touch, drain to the
 * deadline, never outlive the backend's own window.
 */
import { describe, expect, it } from 'vitest';

import {
    DEFAULT_BACKEND_TIMEOUT_MS,
    QUESTION_IDLE_MS,
    QUESTION_SAFETY_MS,
    backendExpiresAt,
    hardDeadline,
    isCapped,
    nextDeadline,
    remainingFraction,
} from '@beaver/agent-core/run-state/askUserQuestionCountdown';

const RECEIVED = 1_000_000;
const LONG_WINDOW_S = 600;
const EXPIRES = backendExpiresAt(RECEIVED, LONG_WINDOW_S);

describe('backendExpiresAt', () => {
    it('takes the window the request names', () => {
        expect(EXPIRES).toBe(RECEIVED + LONG_WINDOW_S * 1000);
    });

    it('falls back to the fixed legacy window when the request does not say', () => {
        expect(backendExpiresAt(RECEIVED, undefined)).toBe(RECEIVED + DEFAULT_BACKEND_TIMEOUT_MS);
        expect(backendExpiresAt(RECEIVED, null)).toBe(RECEIVED + DEFAULT_BACKEND_TIMEOUT_MS);
        expect(backendExpiresAt(RECEIVED, 0)).toBe(RECEIVED + DEFAULT_BACKEND_TIMEOUT_MS);
    });
});

describe('nextDeadline', () => {
    it('gives a fresh card the full idle window', () => {
        expect(nextDeadline(EXPIRES, RECEIVED)).toBe(RECEIVED + QUESTION_IDLE_MS);
    });

    it('refills the idle window from the moment of the touch', () => {
        const touchedAt = RECEIVED + 60_000;

        expect(nextDeadline(EXPIRES, touchedAt)).toBe(touchedAt + QUESTION_IDLE_MS);
    });

    it('stops ahead of the backend window, however often the card is touched', () => {
        const lateTouch = EXPIRES - 10_000;

        expect(nextDeadline(EXPIRES, lateTouch)).toBe(hardDeadline(EXPIRES));
        expect(hardDeadline(EXPIRES)).toBe(EXPIRES - QUESTION_SAFETY_MS);
    });

    it('fits inside the legacy two-minute window of a backend that does not pace', () => {
        const legacyExpires = backendExpiresAt(RECEIVED, undefined);
        const touchedLate = RECEIVED + 100_000;

        expect(nextDeadline(legacyExpires, touchedLate)).toBe(legacyExpires - QUESTION_SAFETY_MS);
        expect(nextDeadline(legacyExpires, touchedLate)).toBeLessThan(legacyExpires);
    });
});

describe('isCapped', () => {
    it('is false while a touch would still push the deadline out', () => {
        expect(isCapped(EXPIRES, RECEIVED)).toBe(false);
    });

    it('is true once the backend window is within one idle window', () => {
        const nearEnd = hardDeadline(EXPIRES) - QUESTION_IDLE_MS;

        expect(isCapped(EXPIRES, nearEnd)).toBe(true);
        expect(isCapped(EXPIRES, nearEnd - 1)).toBe(false);
    });

    it('is true from the start against a legacy window shorter than two idle windows', () => {
        // 120 s window, 90 s idle: a touch after 25 s already hits the cap.
        const legacyExpires = backendExpiresAt(RECEIVED, undefined);

        expect(isCapped(legacyExpires, RECEIVED)).toBe(false);
        expect(isCapped(legacyExpires, RECEIVED + 25_000)).toBe(true);
    });
});

describe('remainingFraction', () => {
    const deadline = RECEIVED + QUESTION_IDLE_MS;

    it('is full right after a touch and drains linearly', () => {
        expect(remainingFraction(deadline, RECEIVED)).toBe(1);
        expect(remainingFraction(deadline, RECEIVED + QUESTION_IDLE_MS / 2)).toBeCloseTo(0.5);
    });

    it('is empty at and after the deadline', () => {
        expect(remainingFraction(deadline, deadline)).toBe(0);
        expect(remainingFraction(deadline, deadline + 5_000)).toBe(0);
    });

    it('caps at one when the deadline is further out than one idle window', () => {
        expect(remainingFraction(RECEIVED + 2 * QUESTION_IDLE_MS, RECEIVED)).toBe(1);
    });
});
