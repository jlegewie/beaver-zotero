import { describe, expect, it } from 'vitest';

import type { AgentRun } from '../../../react/agents/types';
import {
    buildRetryAnchor,
    planRetryRollback,
    resolveRetryTarget,
    restoreRemoved,
    type RemovedThreadTail,
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
    return { runId, anchor: { retryRunId, keepRunIds }, removed: null };
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

    it('re-targets the run an unacknowledged retry was replacing', () => {
        // The rollback put 'b' and 'c' back, and the failed retry 'phantom'
        // sits in the active slot. Regenerating it must replace 'b' again, not
        // anchor on an ID the server has never seen.
        const runs = [makeRun('a'), makeRun('b'), makeRun('c')];
        const phantom = makeRun('phantom');
        const unconfirmed = makeUnconfirmed('phantom', 'b', ['a']);

        const resolved = resolveRetryTarget(unconfirmed, runs, phantom, runs.length);

        expect(resolved.targetRun.id).toBe('b');
        expect(resolved.truncateFromIndex).toBe(1);
        expect(resolved.anchor).toEqual({ retryRunId: 'b', keepRunIds: ['a'] });
    });

    it('inherits the anchor when the replaced run is not back in the thread', () => {
        // Nothing was restored (the failed retry targeted the active run), so
        // the recorded anchor is the only description of what to replace.
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
        // With the run restored the retry anchors on it again and the empty
        // keep set falls back to retryRunId server-side.
        const restored = [makeRun('a')];
        const phantom = makeRun('phantom');
        const unconfirmed = makeUnconfirmed('phantom', 'a', []);

        const resolved = resolveRetryTarget(unconfirmed, restored, phantom, restored.length);

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
            { runId: 'phantom-2', anchor: first.anchor, removed: null },
            runs,
            secondPhantom,
            runs.length,
        );

        expect(second.anchor).toEqual({ retryRunId: 'unpersisted', keepRunIds: ['a', 'b'] });
    });
});

describe('planRetryRollback', () => {
    function makeRemoved(threadId: string | null): RemovedThreadTail {
        return { threadId, runs: [makeRun('b')], actions: [], citations: [], undoneActionIds: [] };
    }

    function makePending(runId: string, removed: RemovedThreadTail | null): UnconfirmedRetry {
        return { runId, anchor: { retryRunId: 'b', keepRunIds: ['a'] }, removed };
    }

    it('restores the tail when the run failed before the acknowledgment', () => {
        const pending = makePending('phantom', makeRemoved('thread-1'));

        expect(planRetryRollback(pending, 'phantom', 'thread-1')).toEqual({
            action: 'restore',
            removed: pending.removed,
        });
    });

    it('does nothing when there is no unconfirmed retry', () => {
        expect(planRetryRollback(null, 'phantom', 'thread-1')).toEqual({ action: 'none' });
    });

    it('does nothing when the failure belongs to a different run', () => {
        const pending = makePending('phantom', makeRemoved('thread-1'));

        expect(planRetryRollback(pending, 'other-run', 'thread-1')).toEqual({ action: 'none' });
    });

    it('does nothing once the tail has already been restored', () => {
        // An acknowledged run also lands here: the ack clears the whole entry.
        const pending = makePending('phantom', null);

        expect(planRetryRollback(pending, 'phantom', 'thread-1')).toEqual({ action: 'none' });
    });

    it('discards the snapshot when the user switched threads', () => {
        const pending = makePending('phantom', makeRemoved('thread-1'));

        expect(planRetryRollback(pending, 'phantom', 'thread-2')).toEqual({ action: 'discard' });
    });

    it('restores a snapshot taken before the thread had an ID', () => {
        const pending = makePending('phantom', makeRemoved(null));

        expect(planRetryRollback(pending, 'phantom', null)).toEqual({
            action: 'restore',
            removed: pending.removed,
        });
    });
});

describe('restoreRemoved', () => {
    it('re-appends removed entries in their original order', () => {
        const current = [{ id: 'a' }];
        const removed = [{ id: 'b' }, { id: 'c' }];

        expect(restoreRemoved(current, removed, (entry) => entry.id)).toEqual([
            { id: 'a' },
            { id: 'b' },
            { id: 'c' },
        ]);
    });

    it('skips entries that are already back in the list', () => {
        const current = [{ id: 'a' }, { id: 'b' }];
        const removed = [{ id: 'b' }, { id: 'c' }];

        expect(restoreRemoved(current, removed, (entry) => entry.id)).toEqual([
            { id: 'a' },
            { id: 'b' },
            { id: 'c' },
        ]);
    });

    it('returns the same array when there is nothing to restore', () => {
        const current = [{ id: 'a' }];

        expect(restoreRemoved(current, [], (entry) => entry.id)).toBe(current);
        expect(restoreRemoved(current, [{ id: 'a' }], (entry) => entry.id)).toBe(current);
    });
});
