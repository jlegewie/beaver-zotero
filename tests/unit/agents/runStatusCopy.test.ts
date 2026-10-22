/**
 * Unit tests for `@beaver/agent-core/run-state/runStatusCopy`.
 */

import { describe, expect, it } from 'vitest';

import type { ReconnectState, RetryState } from '@beaver/agent-core/run-state/atoms';
import {
    RECONNECT_ESCALATE_AFTER_MS,
    RECONNECT_SHOW_AFTER_MS,
    msUntilReconnectPhaseChange,
    reconnectPhase,
    runStatusText,
    stillReconnectingText,
} from '@beaver/agent-core/run-state/runStatusCopy';

const reconnect = (attempt: number, maxAttempts = 4): ReconnectState => ({
    attempt,
    maxAttempts,
});

const backendRetry = (): RetryState => ({
    runId: 'run-1',
    attempt: 2,
    maxAttempts: 3,
    reason: 'upstream timed out',
    waitSeconds: 5,
});

describe('runStatusText', () => {
    it('counts the attempts of a reconnect that is on its second or later try', () => {
        expect(
            runStatusText({
                reconnect: reconnect(2),
                backendRetry: null,
                idleLabel: 'Generating',
            }),
        ).toBe('Reconnecting… (2/4)');
    });

    it('leaves the numbers off a first reconnect attempt', () => {
        expect(
            runStatusText({
                reconnect: reconnect(1),
                backendRetry: null,
                idleLabel: 'Generating',
            }),
        ).toBe('Reconnecting…');
    });

    it('says only that the backend is retrying, without its reason or count', () => {
        expect(
            runStatusText({
                reconnect: null,
                backendRetry: backendRetry(),
                idleLabel: 'Generating',
            }),
        ).toBe('Retrying…');
    });

    it('prefers the reconnect when both are happening at once', () => {
        expect(
            runStatusText({
                reconnect: reconnect(3),
                backendRetry: backendRetry(),
                idleLabel: 'Generating',
            }),
        ).toBe('Reconnecting… (3/4)');
    });

    it('passes the idle label through when neither is happening', () => {
        expect(
            runStatusText({ reconnect: null, backendRetry: null, idleLabel: 'Generating' }),
        ).toBe('Generating');
        expect(
            runStatusText({
                reconnect: null,
                backendRetry: null,
                idleLabel: 'Beaver is working…',
            }),
        ).toBe('Beaver is working…');
    });

    it('counts a long wait out beside the idle label', () => {
        expect(
            runStatusText({
                reconnect: null,
                backendRetry: null,
                idleLabel: 'Generating',
                elapsedSeconds: 12,
            }),
        ).toBe('Generating · 12s');
    });

    it('says nothing about a wait the caller is withholding', () => {
        for (const elapsedSeconds of [undefined, null, 0]) {
            expect(
                runStatusText({
                    reconnect: null,
                    backendRetry: null,
                    idleLabel: 'Generating',
                    elapsedSeconds,
                }),
            ).toBe('Generating');
        }
    });

    it('leaves a reconnect and a retry to their own progress', () => {
        // A second number beside an attempt count reads as part of it.
        expect(
            runStatusText({
                reconnect: reconnect(3),
                backendRetry: null,
                idleLabel: 'Generating',
                elapsedSeconds: 12,
            }),
        ).toBe('Reconnecting… (3/4)');
        expect(
            runStatusText({
                reconnect: null,
                backendRetry: backendRetry(),
                idleLabel: 'Generating',
                elapsedSeconds: 12,
            }),
        ).toBe('Retrying…');
    });
});

describe('a reattach after a lost connection', () => {
    const since = 1_000_000;
    const reattach = (graceMs = 120_000): ReconnectState => ({
        attempt: 1,
        maxAttempts: 4,
        since,
        graceMs,
    });
    const textAt = (elapsed: number, state = reattach(), compact = false) =>
        runStatusText({
            reconnect: state,
            backendRetry: null,
            idleLabel: 'Generating',
            now: since + elapsed,
            compact,
        });

    it('shows nothing for a blip under a second', () => {
        expect(reconnectPhase(reattach(), since + 500)).toBe('hidden');
        expect(textAt(500)).toBe('Generating');
    });

    it('says it is reconnecting once the loss has lasted a second', () => {
        expect(reconnectPhase(reattach(), since + RECONNECT_SHOW_AFTER_MS)).toBe('reconnecting');
        expect(textAt(5_000)).toBe('Reconnecting…');
    });

    it('escalates after 30 s, naming the grace the server announced', () => {
        expect(textAt(RECONNECT_ESCALATE_AFTER_MS - 1)).toBe('Reconnecting…');
        expect(textAt(RECONNECT_ESCALATE_AFTER_MS)).toBe(
            'Still reconnecting… (up to 2 min)',
        );
        expect(textAt(40_000, reattach(600_000))).toBe(
            'Still reconnecting… (up to 10 min)',
        );
    });

    it('never promises more time than the server gives', () => {
        expect(stillReconnectingText(90_000)).toBe(
            'Still reconnecting… (up to 1 min)',
        );
        expect(stillReconnectingText(45_000)).toBe(
            'Still reconnecting… (up to 45 s)',
        );
        expect(stillReconnectingText(undefined)).toBe('Still reconnecting…');
    });

    it('leaves the grace out of a compact line', () => {
        expect(textAt(40_000, reattach(), true)).toBe('Still reconnecting…');
    });

    it('reports when its phase next changes', () => {
        expect(msUntilReconnectPhaseChange(reattach(), since + 200)).toBe(800);
        expect(msUntilReconnectPhaseChange(reattach(), since + 10_000)).toBe(20_000);
        expect(msUntilReconnectPhaseChange(reattach(), since + 31_000)).toBeNull();
    });

    it('shows a connect retry at once and never escalates it', () => {
        expect(reconnectPhase(reconnect(2), 0)).toBe('reconnecting');
        expect(msUntilReconnectPhaseChange(reconnect(2), 0)).toBeNull();
    });
});
