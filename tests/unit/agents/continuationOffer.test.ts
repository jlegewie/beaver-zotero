import { describe, expect, it } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { ContinuationOffer } from '@beaver/agent-core/protocol/agentProtocol';
import {
    continuationOfferFor,
    shouldOfferResume,
    wasRunContinued,
} from '@beaver/agent-core/run-state/runResumeHelpers';

function makeRun(
    id: string,
    status: AgentRun['status'] = 'completed',
    extra: Partial<AgentRun> = {},
): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: '', is_resume: false },
        status,
        model_messages: [],
        created_at: new Date().toISOString(),
        consent_to_share: false,
        model_name: 'gpt-5',
        ...extra,
    };
}

const BATCH_OFFER: ContinuationOffer = {
    kind: 'batch_approval',
    title: 'Batch job waiting',
    message: 'The batch job was not approved in time.',
    continue_label: 'Continue',
    allow_message: true,
    payload: { batch_id: 'tidy-up' },
};

describe('continuationOfferFor', () => {
    it('uses the backend offer whatever the run status is', () => {
        // The batch case finishes cleanly: status alone can never find it.
        const run = makeRun('run-1', 'completed', { continuation: BATCH_OFFER });

        expect(continuationOfferFor(run)).toBe(BATCH_OFFER);
    });

    it('renders a kind it has never heard of', () => {
        const offer = { ...BATCH_OFFER, kind: 'some_future_kind' };
        const run = makeRun('run-1', 'completed', { continuation: offer });

        expect(continuationOfferFor(run)).toBe(offer);
    });

    it('composes the copy for an interrupted run stored before the field existed', () => {
        const run = makeRun('run-1', 'canceled', {
            error: { type: 'canceled', message: 'x', reason_code: 'connection_lost' },
        });

        const offer = continuationOfferFor(run);
        expect(offer?.kind).toBe('interrupted');
        expect(offer?.message).toContain('connection dropped');
        // Nothing typed can reach a backend that predates the field.
        expect(offer?.allow_message).toBe(false);
    });

    it('still offers for an interrupted run whose offer is explicitly null', () => {
        // Null and absent mean the same thing here on purpose: a cut-off run
        // reaching us without an offer is one stored before the field existed,
        // or one whose terminal write shed the offer to save its status. Both
        // deserve the button. The backend suppresses an offer by the run not
        // being a cut-off one, never by nulling this field.
        const run = makeRun('run-1', 'canceled', {
            continuation: null,
            error: { type: 'canceled', message: 'x', reason_code: 'server_shutdown' },
        });

        const offer = continuationOfferFor(run);
        expect(offer?.kind).toBe('interrupted');
        expect(offer?.message).toContain('server restarted');
    });

    it('offers nothing for a run the user stopped', () => {
        const run = makeRun('run-1', 'canceled', {
            error: { type: 'canceled', message: 'x', reason_code: 'client_cancel' },
        });

        expect(continuationOfferFor(run)).toBeNull();
    });

    it('offers nothing for an ordinary finished run', () => {
        expect(continuationOfferFor(makeRun('run-1', 'completed'))).toBeNull();
    });

    it('offers nothing for no run', () => {
        expect(continuationOfferFor(null)).toBeNull();
    });
});

describe('shouldOfferResume with an offer', () => {
    const run = makeRun('run-1', 'completed', { continuation: BATCH_OFFER });

    it('offers on the newest run', () => {
        expect(
            shouldOfferResume(run, { isLastRun: true, resumedRunIds: new Set() }),
        ).toBe(true);
    });

    it('does not offer further up the thread', () => {
        expect(
            shouldOfferResume(run, { isLastRun: false, resumedRunIds: new Set() }),
        ).toBe(false);
    });

    it('does not offer once something already continued it', () => {
        expect(
            shouldOfferResume(run, {
                isLastRun: true,
                resumedRunIds: new Set(['run-1']),
            }),
        ).toBe(false);
    });
});

describe('wasRunContinued with an offer', () => {
    it('a finished run that was picked up gives way to its continuation', () => {
        const run = makeRun('run-1', 'completed', { continuation: BATCH_OFFER });

        expect(wasRunContinued(run, new Set(['run-1']))).toBe(true);
    });

    it('a plain finished run sharing the id is a data error, not a continuation', () => {
        expect(wasRunContinued(makeRun('run-1', 'completed'), new Set(['run-1']))).toBe(
            false,
        );
    });
});
