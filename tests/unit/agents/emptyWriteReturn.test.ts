import { describe, it, expect } from 'vitest';
import { isEmptyWriteReturn } from '@beaver/agent-core/agents/types';
import type { ToolReturnPart } from '@beaver/agent-core/agents/types';

function toolReturn(overrides: Partial<ToolReturnPart> = {}): ToolReturnPart {
    return {
        part_kind: 'tool-return',
        tool_name: 'create_items',
        tool_call_id: 'call_1',
        content: {},
        ...overrides,
    };
}

describe('isEmptyWriteReturn', () => {
    it('treats a bare string payload as a write that changed nothing', () => {
        expect(isEmptyWriteReturn(toolReturn({
            tool_name: 'edit_metadata',
            content: 'The item already has this value.',
        }))).toBe(true);
    });

    // Every reference was already in the library, so no item was created and no
    // agent action exists. The payload only names the existing items for the
    // model, and must not surface as an expandable result.
    it('treats a create_items result with no created items as no change', () => {
        expect(isEmptyWriteReturn(toolReturn({
            content: {
                status: 'applied',
                items_created: {},
                items_already_in_library: { W123: 'u-ABCD2345' },
                note: 'call organize_items(...)',
            },
        }))).toBe(true);
    });

    it('keeps a create_items result that did create something', () => {
        expect(isEmptyWriteReturn(toolReturn({
            content: {
                status: 'applied',
                items_created: { W123: { item_id: 'u-ABCD2345', title: 'A paper' } },
                items_already_in_library: {},
            },
        }))).toBe(false);
    });

    it('does not claim structured payloads from other write tools', () => {
        expect(isEmptyWriteReturn(toolReturn({
            tool_name: 'organize_items',
            content: { status: 'applied', item_count: 0 },
        }))).toBe(false);
    });

    it('ignores an unsuccessful return, which carries an error message', () => {
        expect(isEmptyWriteReturn(toolReturn({
            outcome: 'failed',
            content: 'Something went wrong',
        }))).toBe(false);
    });

    it('ignores a retry prompt and a missing part', () => {
        expect(isEmptyWriteReturn({
            part_kind: 'retry-prompt',
            tool_name: 'create_items',
            tool_call_id: 'call_1',
            content: 'retry',
        })).toBe(false);
        expect(isEmptyWriteReturn(null)).toBe(false);
        expect(isEmptyWriteReturn(undefined)).toBe(false);
    });
});
