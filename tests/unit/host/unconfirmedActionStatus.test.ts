import { describe, expect, it } from 'vitest';

import { STATUS_CONFIGS, getStatusConfig } from '../../../react/host/zotero/components/agentActionViewHelpers';
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
