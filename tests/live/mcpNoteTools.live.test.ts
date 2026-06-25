/**
 * Live tests for the MCP note tools exposed through dev HTTP adapters.
 *
 * Run: `npx vitest run --config vitest.live.config.ts tests/live/mcpNoteTools.live.test.ts`
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { PARENT_ITEM } from '../helpers/fixtures';
import { deleteNote } from './helpers/noteTestClient';

let zoteroAvailable = false;
const createdNoteIds: string[] = [];

interface McpErrorResult {
    isError: true;
    content: Array<{ type: string; text: string }>;
}

interface McpCreateNoteResult {
    note_id: string | null;
    parent_item_id: string | null;
    related_item_id: string | null;
    collection_key: string | null;
    note_content: string | null;
    warning: string | null;
    citation_issues: {
        invalid_keys: string[];
        errors: unknown[];
    };
}

interface McpReadNoteResult {
    note_id: string;
    title: string | null;
    parent_item_id: string | null;
    parent_title: string | null;
    total_lines: number | null;
    lines_returned: string | null;
    has_more: boolean;
    next_offset: number | null;
    content: string;
    cited_items: Array<{ item_id: string; item_type: string; title: string | null }>;
}

function isMcpError(result: unknown): result is McpErrorResult {
    return !!result && typeof result === 'object' && (result as { isError?: unknown }).isError === true;
}

function splitNoteId(noteId: string): { libraryId: number; zoteroKey: string } {
    const dash = noteId.indexOf('-');
    if (dash <= 0) throw new Error(`Invalid note_id returned by MCP tool: ${noteId}`);
    return {
        libraryId: Number(noteId.slice(0, dash)),
        zoteroKey: noteId.slice(dash + 1),
    };
}

async function mcpCreateNote(args: Record<string, unknown>): Promise<McpCreateNoteResult> {
    const res = await post<{ result: McpCreateNoteResult | McpErrorResult }>(
        '/beaver/test/mcp-create-note',
        args,
    );
    if (isMcpError(res.result)) {
        throw new Error(res.result.content.map((part) => part.text).join('\n'));
    }
    if (res.result.note_id) {
        createdNoteIds.push(res.result.note_id);
    }
    return res.result;
}

async function mcpCreateNoteRaw(args: Record<string, unknown>) {
    return post<{ result: McpCreateNoteResult | McpErrorResult }>(
        '/beaver/test/mcp-create-note',
        args,
    );
}

async function mcpReadNote(noteId: string): Promise<McpReadNoteResult> {
    const res = await post<{ result: McpReadNoteResult | McpErrorResult }>(
        '/beaver/test/mcp-read-note',
        { note_id: noteId },
    );
    if (isMcpError(res.result)) {
        throw new Error(res.result.content.map((part) => part.text).join('\n'));
    }
    return res.result;
}

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — MCP note tool live tests will be skipped.\n'
            + 'Start Zotero with a dev build of Beaver loaded and authenticated.\n',
        );
    }
});

afterEach(async () => {
    for (const noteId of createdNoteIds) {
        try {
            const { libraryId, zoteroKey } = splitNoteId(noteId);
            await deleteNote(libraryId, zoteroKey);
        } catch {
            // Best-effort cleanup.
        }
    }
    createdNoteIds.length = 0;
});

describe('MCP note tools', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('creates a standalone note with a real citation and reads it back', async () => {
        const itemId = `${PARENT_ITEM.library_id}-${PARENT_ITEM.zotero_key}`;
        const created = await mcpCreateNote({
            title: 'MCP citation note',
            content: `A claim with a source. <citation id="${itemId}"/>`,
        });

        expect(created.note_id).toMatch(/^\d+-[A-Z0-9]{8}$/);
        expect(created.note_content).toContain('<citation');
        expect(created.note_content).toContain(`id="${itemId}"`);
        expect(created.citation_issues.invalid_keys).toEqual([]);

        const read = await mcpReadNote(created.note_id!);
        expect(read.note_id).toBe(created.note_id);
        expect(read.content).toContain('<citation');
        expect(read.content).toContain(`id="${itemId}"`);
        expect(read.cited_items.map((item) => item.item_id)).toContain(itemId);
    });

    it('creates a child note and drops collection assignment', async () => {
        const parentId = `${PARENT_ITEM.library_id}-${PARENT_ITEM.zotero_key}`;
        const created = await mcpCreateNote({
            title: 'MCP child note',
            content: 'Child note body.',
            parent_id: parentId,
            collection: 'ignored-when-parent-is-set',
        });

        expect(created.note_id).toMatch(/^\d+-[A-Z0-9]{8}$/);
        expect(created.parent_item_id).toBe(parentId);
        expect(created.collection_key).toBeNull();
    });

    it('surfaces fabricated citation IDs as citation issues', async () => {
        const created = await mcpCreateNote({
            title: 'MCP bad citation',
            content: 'Bad citation. <citation id="not-a-real-id"/>',
        });

        expect(created.note_id).toMatch(/^\d+-[A-Z0-9]{8}$/);
        expect(created.citation_issues.invalid_keys).toContain('not-a-real-id');
    });

    it('returns an MCP error object for missing content', async () => {
        const res = await mcpCreateNoteRaw({
            title: 'Missing content',
            content: '',
        });

        expect(isMcpError(res.result)).toBe(true);
        if (isMcpError(res.result)) {
            expect(res.result.content[0]?.text).toMatch(/content/i);
        }
    });
});
