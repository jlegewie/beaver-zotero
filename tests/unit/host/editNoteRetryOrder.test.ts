import { describe, expect, it } from 'vitest';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { getEditNoteRetryOrder } from '../../../react/host/zotero/components/editNoteRetryOrder';

const action = (id: string, resultData?: Record<string, unknown>): AgentAction => ({
    id,
    run_id: 'run-1',
    toolcall_id: `call-${id}`,
    action_type: 'edit_note',
    status: 'error',
    proposed_data: {},
    result_data: resultData,
});

describe('getEditNoteRetryOrder', () => {
    it('retries failed undos newest-to-oldest and failed applies in original order', () => {
        const applyOld = action('apply-old');
        const undoOld = action('undo-old', { undo_old_html: 'old' });
        const applyNew = action('apply-new');
        const undoNew = action('undo-new', { undo_old_html: 'new' });

        const result = getEditNoteRetryOrder([applyOld, undoOld, applyNew, undoNew]);

        expect(result.undoActions.map((item) => item.id)).toEqual(['undo-new', 'undo-old']);
        expect(result.applyActions.map((item) => item.id)).toEqual(['apply-old', 'apply-new']);
    });
});
