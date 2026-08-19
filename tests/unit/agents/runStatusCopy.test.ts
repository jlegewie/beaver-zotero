/**
 * Unit tests for `@beaver/agent-core/run-state/runStatusCopy`.
 */

import { describe, expect, it } from 'vitest';

import type { ReconnectState, RetryState } from '@beaver/agent-core/run-state/atoms';
import { runStatusText } from '@beaver/agent-core/run-state/runStatusCopy';

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
});
