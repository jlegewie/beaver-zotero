import { describe, expect, it } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import {
    buildRetryAnchor,
    resolveRetryTarget,
    type UnconfirmedRetry,
} from '../../../react/agents/retryReconciliation';

function makeRun(id: string): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: `prompt for ${id}` },
        status: 'completed',
        model_messages: [],
        created_at: new Date().toISOString(),
        consent_to_share: false,
        model_name: 'gpt-5',
    };
}

function makeUnconfirmed(
    runId: string,
    retryRunId: string,
    keepRunIds: string[] = [],
): UnconfirmedRetry {
    return { runId, anchor: { retryRunId, keepRunIds } };
}

describe('buildRetryAnchor', () => {
    it('keeps the runs before the truncation point', () => {
        const runs = [makeRun('a'), makeRun('b'), makeRun('c')];

        expect(buildRetryAnchor(runs, 'b', 1)).toEqual({
            retryRunId: 'b',
            keepRunIds: ['a'],
        });
    });

    it('keeps every run when the target is the active run', () => {
        const runs = [makeRun('a'), makeRun('b')];

        // The active run is not in threadRuns, so nothing in the list is dropped.
        expect(buildRetryAnchor(runs, 'active', runs.length)).toEqual({
            retryRunId: 'active',
            keepRunIds: ['a', 'b'],
        });
    });

    it('keeps nothing when the first run is regenerated', () => {
        const runs = [makeRun('a'), makeRun('b')];

        // An empty keep set is unanchored server-side, which falls back to
        // retryRunId rather than deleting the thread.
        expect(buildRetryAnchor(runs, 'a', 0)).toEqual({
            retryRunId: 'a',
            keepRunIds: [],
        });
    });
});

describe('resolveRetryTarget', () => {
    it('anchors on the target run when nothing is unconfirmed', () => {
        const runs = [makeRun('a'), makeRun('b'), makeRun('c')];

        const resolved = resolveRetryTarget(null, runs, runs[1], 1);

        expect(resolved.targetRun.id).toBe('b');
        expect(resolved.truncateFromIndex).toBe(1);
        expect(resolved.anchor).toEqual({ retryRunId: 'b', keepRunIds: ['a'] });
    });

    it('anchors on the target run when the unconfirmed retry is a different run', () => {
        const runs = [makeRun('a'), makeRun('b')];

        const resolved = resolveRetryTarget(makeUnconfirmed('other', 'a'), runs, runs[1], 1);

        expect(resolved.anchor).toEqual({ retryRunId: 'b', keepRunIds: ['a'] });
    });

    it('re-targets the run an unconfirmed retry was replacing', () => {
        // The thread was reloaded, so 'b' and 'c' are back and the failed retry
        // 'phantom' sits in the active slot. Regenerating it must replace 'b'
        // again, not anchor on an ID the server has never seen.
        const runs = [makeRun('a'), makeRun('b'), makeRun('c')];
        const phantom = makeRun('phantom');
        const unconfirmed = makeUnconfirmed('phantom', 'b', ['a']);

        const resolved = resolveRetryTarget(unconfirmed, runs, phantom, runs.length);

        expect(resolved.targetRun.id).toBe('b');
        expect(resolved.truncateFromIndex).toBe(1);
        expect(resolved.anchor).toEqual({ retryRunId: 'b', keepRunIds: ['a'] });
    });

    it('inherits the anchor when the replaced run is not in the thread', () => {
        // The replaced run is gone from the local view, so the recorded anchor
        // is the only description of what to replace.
        const runs = [makeRun('a')];
        const phantom = makeRun('phantom');
        const unconfirmed = makeUnconfirmed('phantom', 'was-active', ['a']);

        const resolved = resolveRetryTarget(unconfirmed, runs, phantom, runs.length);

        expect(resolved.targetRun.id).toBe('phantom');
        expect(resolved.truncateFromIndex).toBe(runs.length);
        expect(resolved.anchor).toEqual({ retryRunId: 'was-active', keepRunIds: ['a'] });
    });

    it('re-targets the only run in a thread that regenerated down to empty', () => {
        // The reported drift: one run, regenerated, the request never landed.
        // Once the run is back in the list the retry anchors on it again, and
        // the empty keep set falls back to retryRunId server-side.
        const reloaded = [makeRun('a')];
        const phantom = makeRun('phantom');
        const unconfirmed = makeUnconfirmed('phantom', 'a', []);

        const resolved = resolveRetryTarget(unconfirmed, reloaded, phantom, reloaded.length);

        expect(resolved.targetRun.id).toBe('a');
        expect(resolved.truncateFromIndex).toBe(0);
        expect(resolved.anchor).toEqual({ retryRunId: 'a', keepRunIds: [] });
    });

    it('anchors on the target itself when it is part of thread history', () => {
        // A run that never reached the server only ever sits in the active
        // slot. One that is in threadRuns is real history, so a stale entry
        // naming it must not redirect the retry at what that entry replaced.
        const runs = [makeRun('a'), makeRun('b'), makeRun('c')];
        const stale = makeUnconfirmed('c', 'a', []);

        const resolved = resolveRetryTarget(stale, runs, runs[2], 2);

        expect(resolved.targetRun.id).toBe('c');
        expect(resolved.truncateFromIndex).toBe(2);
        expect(resolved.anchor).toEqual({ retryRunId: 'c', keepRunIds: ['a', 'b'] });
    });

    it('carries the inherited anchor across a chain of failed retries', () => {
        const runs = [makeRun('a'), makeRun('b')];
        const firstPhantom = makeRun('phantom-1');

        const first = resolveRetryTarget(
            makeUnconfirmed('phantom-1', 'unpersisted', ['a', 'b']),
            runs,
            firstPhantom,
            runs.length,
        );
        const secondPhantom = makeRun('phantom-2');
        const second = resolveRetryTarget(
            { runId: 'phantom-2', anchor: first.anchor },
            runs,
            secondPhantom,
            runs.length,
        );

        expect(second.anchor).toEqual({ retryRunId: 'unpersisted', keepRunIds: ['a', 'b'] });
    });
});
