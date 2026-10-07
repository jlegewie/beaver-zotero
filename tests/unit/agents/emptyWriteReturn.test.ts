import { describe, it, expect } from 'vitest';
import { isEmptyWriteReturn, isNotFoundWriteReturn } from '@beaver/agent-core/agents/types';
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

    describe('create_items v2 results (one outcome per input)', () => {
        it('is no change when every input was already in the library or repeated', () => {
            expect(isEmptyWriteReturn(toolReturn({
                content: { status: 'applied', items: [
                    { input: 'doi:10.1/a', outcome: 'already_in_library', item_id: 'u-ABCD2345' },
                    { input: 'doi:10.1/b', outcome: 'duplicate_in_call', duplicate_of: 'doi:10.1/a' },
                ] },
            }))).toBe(true);
        });

        it('is not no change when an input failed', () => {
            expect(isEmptyWriteReturn(toolReturn({
                content: { status: 'applied', items: [
                    { input: 'doi:10.1/a', outcome: 'already_in_library' },
                    { input: 'ext-ABCD1234', outcome: 'failed', error_code: 'unrecognized_file' },
                ] },
            }))).toBe(false);
        });

        it('is not no change when an item was created', () => {
            expect(isEmptyWriteReturn(toolReturn({
                content: { status: 'applied', items: [{ input: 'doi:10.1/a', outcome: 'created' }] },
            }))).toBe(false);
        });
    });
});

describe('manage_tags no-op results', () => {
    const manageTags = (status: string) => toolReturn({
        tool_name: 'manage_tags',
        content: { status, action: 'rename', name: 'old', new_name: 'new', items_affected: 0 },
    });

    it('treats unchanged and not_found as no change', () => {
        expect(isEmptyWriteReturn(manageTags('unchanged'))).toBe(true);
        expect(isEmptyWriteReturn(manageTags('not_found'))).toBe(true);
    });

    it('keeps results that changed or may change the library', () => {
        for (const status of ['applied', 'pending', 'rejected']) {
            expect(isEmptyWriteReturn(manageTags(status))).toBe(false);
        }
    });

    it('flags only not_found as a missing target', () => {
        expect(isNotFoundWriteReturn(manageTags('not_found'))).toBe(true);
        expect(isNotFoundWriteReturn(manageTags('unchanged'))).toBe(false);
        expect(isNotFoundWriteReturn(toolReturn({
            tool_name: 'manage_tags',
            outcome: 'failed',
            content: { status: 'not_found' },
        }))).toBe(false);
        expect(isNotFoundWriteReturn(null)).toBe(false);
    });
});
