/** Exercise the actual JSON-RPC endpoint with MCP and annotation tools enabled. */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { SMALL_PDF, NON_PDF } from '../helpers/fixtures';
import { post } from '../helpers/zoteroHttpClient';
import { getExcludedLibraries, setExcludedLibraries, restoreExcludedLibraries } from '../helpers/cacheInspector';

let available = false;
let createdIds: string[] = [];
let fixtureIds: string[] = [];
const attachmentId = `${SMALL_PDF.library_id}-${SMALL_PDF.zotero_key}`;
const tag = `mcp-annotation-test-${Date.now()}`;

async function rpc(method: string, params?: any): Promise<any> {
    const response = await post<any>('/beaver/mcp', { jsonrpc: '2.0', id: 1, method, params }, { timeout: 120000 });
    expect(response.error).toBeUndefined();
    return response.result;
}
async function call(name: string, args: any = {}, allowError = false): Promise<any> {
    const result = await rpc('tools/call', { name, arguments: args });
    let data: any;
    try { data = JSON.parse(result.content[0].text); } catch { data = null; }
    for (const annotation of data?.created ?? []) createdIds.push(annotation.annotation_id);
    if (!allowError) expect(result.isError, result.content?.[0]?.text).not.toBe(true);
    return allowError ? { result, data } : data;
}

beforeAll(async () => { available = await isZoteroAvailable(); });
beforeEach(ctx => { skipIfNoZotero(ctx, available); createdIds = []; fixtureIds = []; });
afterEach(async () => {
    try {
        if (createdIds.length) await post('/beaver/delete-items', { item_ids: createdIds });
    } finally {
        if (fixtureIds.length) await post('/beaver/delete-items', { item_ids: fixtureIds });
    }
});

describe('MCP library and annotation tools', () => {
    it('discovers all four tools with correct read/write hints', async () => {
        const { tools } = await rpc('tools/list');
        for (const name of ['list_libraries', 'find_annotations', 'create_highlight_annotations', 'create_note_annotations']) {
            const tool = tools.find((entry: any) => entry.name === name);
            expect(tool, `${name} must be enabled in this Zotero instance`).toBeDefined();
            expect(tool.annotations.readOnlyHint).toBe(!name.startsWith('create_'));
        }
    });

    it('lists usable library identities and permissions', async () => {
        const result = await call('list_libraries');
        expect(result.total_count).toBe(result.libraries.length);
        expect(result.libraries.find((library: any) => library.library_ref === 'u')).toMatchObject({ read_only: false, is_group: false });
        expect(result.libraries.every((library: any) => Number.isInteger(library.item_count))).toBe(true);
    });

    it('finds no annotations for a unique unused tag', async () => {
        const result = await call('find_annotations', { tag });
        expect(result).toMatchObject({ annotations: [], total_count: 0, has_more: false, next_offset: null });
    });

    for (const type of ['highlight', 'note']) {
        it(`creates a ${type} using extracted PDF geometry and finds its persisted content`, async () => {
            const document = await call('read_attachment', { attachment_id: attachmentId, start_page: 1, end_page: 1, include_annotation_locations: true });
            const passage = document.pages[0].passages.find((item: any) => item.text?.trim());
            expect(passage).toBeDefined();
            const item = type === 'highlight'
                ? { text: passage.text, page_locations: passage.page_locations, comment: 'MCP live highlight', color: 'blue' }
                : { note_position: passage.note_position, comment: 'MCP live sticky note', color: 'green' };
            const result = await call(`create_${type}_annotations`, { attachment_id: attachmentId, items: [item], tags: [tag] });
            expect(result).toMatchObject({ total_created: 1, total_failed: 0 });
            expect(result.created[0].annotation_id).toMatch(/^u-/);
            const found = await call('find_annotations', { attachment_id: attachmentId, tag, annotation_type: type });
            expect(found.total_count).toBe(1);
            expect(found.annotations[0]).toMatchObject({ annotation_id: result.created[0].annotation_id, comment: item.comment, annotation_type: type, tags: [tag] });
            if (type === 'highlight') expect(found.annotations[0].text).toBe(passage.text);
            expect(found.annotations[0].page).toBe(1);
        }, 120000);
    }

    it('returns successful writes alongside out-of-range page failures', async () => {
        const position = { page_index: 0, x: 100, y: 100, side: 'right', coord_origin: 't' };
        const { result, data } = await call('create_note_annotations', { attachment_id: attachmentId, tags: [tag], items: [
            { comment: 'Valid page', note_position: position },
            { comment: 'Invalid page', note_position: { ...position, page_index: 999999 } },
        ] }, true);
        expect(result.isError).toBe(true);
        expect(data).toMatchObject({ total_created: 1, total_failed: 1 });
        expect(data.failed[0].index).toBe(1);
        expect((await call('find_annotations', { tag })).total_count).toBe(1);
    }, 120000);

    it('rejects PDF notes without a PDF position instead of silently placing them on page one', async () => {
        const { result } = await call('create_note_annotations', { attachment_id: attachmentId, items: [{ comment: 'Invalid locator', anchor_id: 'p1' }] }, true);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('note_position');
    });
});


describe('MCP excluded-library boundary', () => {
    it('hides excluded libraries and rejects annotation reads and both writes', async () => {
        const original = await getExcludedLibraries();
        try {
            expect((await setExcludedLibraries([SMALL_PDF.library_id])).ok).toBe(true);
            const libraries = await call('list_libraries');
            expect(libraries.libraries.some((library: any) => library.library_id === SMALL_PDF.library_id)).toBe(false);
            const search = await call('find_annotations', { library: SMALL_PDF.library_id, tag }, true);
            expect(search.result.isError).toBe(true);
            for (const name of ['create_highlight_annotations', 'create_note_annotations']) {
                const item = name === 'create_highlight_annotations'
                    ? { text: 'Excluded source', page_locations: [{ page_idx: 0, boxes: [{ l: 10, t: 20, r: 80, b: 30, coord_origin: 't' }] }] }
                    : { comment: 'Excluded note', note_position: { page_index: 0, x: 100, y: 100, side: 'right', coord_origin: 't' } };
                const response = await call(name, { attachment_id: attachmentId, items: [item], tags: [tag] }, true);
                expect(response.result.isError).toBe(true);
                expect(response.result.content[0].text).toMatch(/excluded|not searchable/i);
            }
        } finally {
            expect((await restoreExcludedLibraries(original.excluded_libraries)).ok).toBe(true);
        }
        expect((await call('find_annotations', { tag })).total_count).toBe(0);
    });
});


describe('MCP EPUB and snapshot annotations', () => {
    for (const kind of ['epub', 'snapshot'] as const) {
        for (const type of ['highlight', 'note']) {
            it(`creates and reads back a ${kind} ${type} using returned locators`, async () => {
                let attachment_id = `${NON_PDF.library_id}-${NON_PDF.zotero_key}`;
                if (kind === 'snapshot') {
                    const fixture = await post<any>('/beaver/test/create-report', { libraryID: SMALL_PDF.library_id, spec: {
                        title: 'MCP annotation test', sections: [{ heading: 'Passage', blocks: [{ type: 'paragraph', text: 'This temporary local HTML snapshot contains a source passage for verifying that MCP annotations can be created and read back.' }] }],
                    } });
                    expect(fixture.ok, fixture.error).toBe(true);
                    attachment_id = `${fixture.report.libraryID}-${fixture.report.key}`;
                    fixtureIds.push(attachment_id);
                }
                const document = await call('read_attachment', { attachment_id, include_annotation_locations: true });
                expect(document.content_kind).toBe(kind);
                const passage = document.passages.find((entry: any) => entry.text.length > 60);
                expect(passage).toBeDefined();
                const created = await call(`create_${type}_annotations`, { attachment_id, tags: [tag], items: [{ ...passage, comment: 'MCP DOM annotation' }] });
                expect(created).toMatchObject({ total_created: 1, total_failed: 0 });
                const found = await call('find_annotations', { attachment_id, tag, annotation_type: type });
                expect(found.total_count).toBe(1);
                expect(found.annotations[0]).toMatchObject({ annotation_id: created.created[0].annotation_id, comment: 'MCP DOM annotation' });
            }, 120000);
        }
    }
});
