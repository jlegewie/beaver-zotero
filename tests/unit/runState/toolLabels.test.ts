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

    it('humanizes the name of a tool this client has no label for', () => {
        const part = toolCall({ tool_name: 'find_book_chapters', args: {} });
        expect(getToolCallLabel(part, 'completed')).toBe('Find book chapters');
        expect(getToolCallLabel({ ...part, progress: 'Querying Crossref' }, 'in_progress'))
            .toBe('Find book chapters: Querying Crossref');
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

    it('names the tag a manage_tags call operates on', () => {
        const part = toolCall({ tool_name: 'manage_tags', args: { action: 'rename', name: 'methods', new_name: 'methodology' } });
        expect(getToolCallLabel(part, 'completed')).toBe('Manage tags: "methods"');
    });

    it('does not call a write on a missing target unnecessary', () => {
        const part = toolCall({ tool_name: 'manage_tags', args: { action: 'delete', name: 'gone' } });
        expect(getToolCallLabel(part, 'completed', { noChange: true }))
            .toBe('Manage tags: no change needed');
        expect(getToolCallLabel(part, 'completed', { noChange: true, notFound: true }))
            .toBe('Manage tags: nothing found to change');
    });
});

describe('getToolCallLabel for create_items', () => {
    const importCall = (items: unknown[]) => toolCall({ tool_name: 'create_items', args: { items } });

    it('names the lookup while the sources are being resolved', () => {
        expect(getToolCallLabel(importCall([{ id: '10.1/a' }, { id: 'https://x.org' }]), 'in_progress'))
            .toMatch(/looking up 2 sources…$/);
        expect(getToolCallLabel(importCall([{ id: '10.1/a' }]), 'in_progress')).toMatch(/looking up 1 source…$/);
    });

    it('drops the lookup note once the call completed', () => {
        expect(getToolCallLabel(importCall([{ id: '10.1/a' }]), 'completed')).not.toMatch(/looking up/);
    });
});
