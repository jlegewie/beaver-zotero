import { describe, expect, it } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import { buildRetryAnchor } from '../../../react/agents/retryReconciliation';

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

        // Sent as an empty set rather than dropped: it tells the server the
        // client holds nothing here, which discards the whole thread — the only
        // anchor a retry on the first run has.
        expect(buildRetryAnchor(runs, 'a', 0)).toEqual({
            retryRunId: 'a',
            keepRunIds: [],
        });
    });
});
