import { describe, it, expect } from 'vitest';
import { getToolCallLabel } from '@beaver/agent-core/run-state/toolLabels';
import type { ToolCallPart } from '@beaver/agent-core/agents/types';

function toolCall(overrides: Partial<ToolCallPart> = {}): ToolCallPart {
    return {
        part_kind: 'tool-call',
        tool_name: 'edit_metadata',
        tool_call_id: 'call_1',
        args: { item_id: '1-ABCD1234', edits: { abstractNote: 'unchanged' } },
        ...overrides,
    };
}

describe('getToolCallLabel', () => {
    it('reports a write that changed nothing', () => {
        expect(getToolCallLabel(toolCall(), 'completed', { noChange: true }))
            .toBe('Edit metadata: no change needed');
    });

    it('keeps the plain label when the write did change something', () => {
        expect(getToolCallLabel(toolCall(), 'completed', { noChange: false }))
            .toBe('Edit metadata');
        expect(getToolCallLabel(toolCall(), 'completed')).toBe('Edit metadata');
    });

    it('lets an in-progress progress message win over the no-change label', () => {
        const part = toolCall({ progress: 'Applying edits' });
        expect(getToolCallLabel(part, 'in_progress', { noChange: true }))
            .toBe('Edit metadata: Applying edits');
    });

    // create_items normally renders as an agent-action card, so its label is only
    // reached when the call created nothing. Without a base label the row read
    // "Calling function".
    it('names create_items rather than falling back to the generic label', () => {
        const part = toolCall({
            tool_name: 'create_items',
            args: { external_reference_ids: ['W123'] },
        });
        expect(getToolCallLabel(part, 'completed')).toBe('Import items');
        expect(getToolCallLabel(part, 'completed', { noChange: true }))
            .toBe('Import items: no change needed');
    });
});
