import { describe, expect, it } from 'vitest';

import { STATUS_CONFIGS, getStatusConfig, unconfirmedCaption } from '../../../react/host/zotero/components/agentActionViewHelpers';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

const action = (status: AgentAction['status'], error_details?: Record<string, any>): AgentAction => ({
    id: 'action-1',
    run_id: 'run-1',
    action_type: 'create_note',
    status,
    proposed_data: {},
    error_details,
} as any);

describe('getStatusConfig', () => {
    it('offers neither apply nor retry for an action whose outcome is unknown', () => {
        const config = getStatusConfig('error', [action('error', { outcome: 'unconfirmed', reason: 'no_result' })]);

        expect(config.label).toBe('Unconfirmed');
        expect(config).toMatchObject({ showApply: false, showReject: false, showUndo: false, showRetry: false });
    });

    it('keeps retry for a failure that is known', () => {
        expect(getStatusConfig('error', [action('error')])).toBe(STATUS_CONFIGS.error);
        expect(getStatusConfig('error', [action('error', { outcome: 'not_sent' })])).toBe(STATUS_CONFIGS.error);
    });

    it('keeps retry for a batch that also holds a known failure', () => {
        const actions = [action('error', { outcome: 'unconfirmed' }), action('error')];
        expect(getStatusConfig('error', actions)).toBe(STATUS_CONFIGS.error);
    });

    it('leaves other statuses alone', () => {
        expect(getStatusConfig('pending', [action('pending')])).toBe(STATUS_CONFIGS.pending);
        expect(getStatusConfig('applied', [action('applied'), action('error', { outcome: 'unconfirmed' })]))
            .toBe(STATUS_CONFIGS.applied);
    });
});

describe('unconfirmedCaption', () => {
    const unconfirmed = (error_message?: string): AgentAction => ({
        ...action('error', { outcome: 'unconfirmed', reason: 'no_result' }),
        error_message,
    });

    it("gives the server's explanation for a card whose only action is unconfirmed", () => {
        expect(unconfirmedCaption([unconfirmed('Zotero stopped responding. Check the item.')]))
            .toBe('Zotero stopped responding. Check the item.');
    });

    it('explains an unconfirmed action stored without a message', () => {
        expect(unconfirmedCaption([unconfirmed()])).toMatch(/^Zotero did not report whether this change was applied/);
    });

    it('counts the unconfirmed actions of a card that holds others', () => {
        expect(unconfirmedCaption([unconfirmed('A'), action('applied')])).toBe(
            'Zotero did not report whether one of these changes was applied. Check the item in Zotero before asking again.',
        );
        expect(unconfirmedCaption([unconfirmed('A'), unconfirmed('B')])).toBe(
            'Zotero did not report whether 2 of these changes were applied. Check the items in Zotero before asking again.',
        );
    });

    it('says a retry of the known failures leaves the unconfirmed ones out', () => {
        expect(unconfirmedCaption([unconfirmed('A'), action('error')])).toMatch(/Retrying leaves it out\.$/);
    });

    it('says nothing for a card without unconfirmed actions', () => {
        expect(unconfirmedCaption([action('error'), action('applied')])).toBeNull();
    });
});
