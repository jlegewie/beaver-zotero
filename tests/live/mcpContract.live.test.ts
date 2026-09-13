/** Behavioral checks through the public MCP transport against a Zotero library. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { PARENT_ITEM } from '../helpers/fixtures';
import { deleteNote } from './helpers/noteTestClient';

let available = false;
const zeroWindowTest = process.env.BEAVER_ZERO_WINDOW_TEST === '1';
const collections: string[] = [];
const duplicateName = `MCP contract test ${Date.now()}`;
async function call(
    name: string,
    args: any = {},
    allowError = false,
): Promise<any> {
    const response = await post<any>(
        '/beaver/mcp',
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
        },
        { timeout: 120000 },
    );
    expect(response.error).toBeUndefined();
    if (allowError) return response.result;
    expect(
        response.result.isError,
        response.result.content?.[0]?.text,
    ).not.toBe(true);
    return JSON.parse(response.result.content[0].text);
}
beforeAll(async () => {
    available = await isZoteroAvailable();
});
beforeEach((ctx) => skipIfNoZotero(ctx, available));
afterAll(async () => {
    if (collections.length)
        await post('/beaver/test/collection-delete', {
            library_id: 1,
            collection_keys: collections,
        });
});

describe('MCP argument and result contracts', () => {
    it.each([
        { item_category: 'annotation' },
        { tags_filter: ['test'] },
        { recursive: 'false' },
        { tag: [4] },
    ])('rejects misleading list arguments %j', async (args) => {
        expect((await call('list_items', args, true)).isError).toBe(true);
    });
    it('omits unrequested collection counts', async () => {
        const result = await call('list_collections', {
            include_item_counts: false,
        });
        expect(result.collections.length).toBeGreaterThan(0);
        for (const collection of result.collections) {
            expect(collection).not.toHaveProperty('item_count');
            expect(collection).not.toHaveProperty('standalone_note_count');
            expect(collection).not.toHaveProperty(
                'standalone_attachment_count',
            );
        }
    });
    it('agrees on unique tag counts across library and tag listings', async () => {
        const libraries = await call('list_libraries');
        const tags = await call('list_tags', {
            library: 'u',
            tag_type: 'all',
            min_item_count: 0,
        });
        expect(
            libraries.libraries.find(
                (library: any) => library.library_ref === 'u',
            ).tag_count,
        ).toBe(tags.total_count);
    });
    it('rejects duplicate collection names and accepts an exact ID', async () => {
        for (let index = 0; index < 2; index++) {
            const created = await post<any>('/beaver/test/collection-create', {
                library_id: 1,
                name: duplicateName,
            });
            if (created.collection_key)
                collections.push(created.collection_key);
            expect(created.ok, created.error).toBe(true);
        }
        for (const [tool, args] of [
            ['list_items', { collection: duplicateName }],
            [
                'search_by_metadata',
                { title_query: 'police', collections_filter: [duplicateName] },
            ],
            [
                'search_by_topic',
                { topic_query: 'police', collections_filter: [duplicateName] },
            ],
        ] as const) {
            const error = await call(tool, args, true);
            expect(error.isError).toBe(true);
            expect(error.content[0].text).toContain('Ambiguous collection');
            for (const key of collections)
                expect(error.content[0].text).toContain(key);
        }
        expect(
            (await call('list_items', { collection: `u-${collections[0]}` }))
                .total_count,
        ).toBe(0);
    });
    it('normalizes metadata IDs and exposes attachment MIME types', async () => {
        const result = await call('get_item_details', {
            item_ids: [`${PARENT_ITEM.library_id}-${PARENT_ITEM.zotero_key}`],
            include_attachments: true,
        });
        expect(result.items[0].item_id).toBe(`u-${PARENT_ITEM.zotero_key}`);
        expect(
            result.items[0].attachments.some(
                (attachment: any) =>
                    attachment.content_kind === 'pdf' &&
                    attachment.content_type === 'application/pdf',
            ),
        ).toBe(true);
        const listed = await call('list_items', {
            item_category: 'attachment',
            limit: 100,
        });
        const pdf = listed.items.find(
            (item: any) => item.content_kind === 'pdf',
        );
        expect(pdf?.content_type).toBe('application/pdf');
    });
    it.runIf(zeroWindowTest)('rejects Markdown note creation without a renderer and saves no note', async () => {
        const { windows } = await post<any>('/beaver/test/window-runtime', { command: 'list' });
        expect(windows).toEqual([]);
        const noteIds = async (): Promise<string[]> => {
            const ids: string[] = [];
            for (let offset = 0; ; offset += 100) {
                const page = await call('list_items', { library: 'u', item_category: 'note', limit: 100, offset });
                ids.push(...page.items.map((item: any) => item.item_id));
                if (!page.has_more) return ids.sort();
            }
        };
        const before = await noteIds();
        const result = await call('create_note', {
            title: 'MCP contract unavailable renderer',
            content: 'This note requires Markdown rendering.',
        }, true);
        try {
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Note rendering is unavailable');
            expect(await noteIds()).toEqual(before);
        } finally {
            if (!result.isError) {
                const note = JSON.parse(result.content[0].text);
                if (note.note_id) await deleteNote(1, note.note_id.split('-')[1]);
            }
        }
    });
    it.skipIf(zeroWindowTest)('includes directly cited PDF attachments in note citation summaries', async () => {
        let attachment: any;
        for (let offset = 0; !attachment; offset += 100) {
            const page = await call('list_items', {
                item_category: 'attachment',
                limit: 100,
                offset,
            });
            attachment = page.items.find(
                (item: any) =>
                    item.content_kind === 'pdf' &&
                    item.parent_item_id == null &&
                    item.status === 'available',
            );
            if (!page.has_more) break;
        }
        expect(
            attachment,
            'A readable standalone PDF fixture is required',
        ).toBeDefined();
        const note = await call('create_note', {
            title: 'MCP contract citation',
            content: `Source: <citation id="${attachment.item_id}" loc="page1"/>`,
        });
        try {
            const read = await call('read_note', { note_id: note.note_id });
            expect(read.content).toContain(`id="${attachment.item_id}"`);
            expect(read.cited_items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        item_id: attachment.item_id,
                        item_type: 'attachment',
                    }),
                ]),
            );
        } finally {
            await deleteNote(1, note.note_id.split('-')[1]);
        }
    });
    it('allows paginated annotation browsing without filters', async () => {
        const result = await call('find_annotations', { limit: 1 });
        expect(result.annotations.length).toBeLessThanOrEqual(1);
        expect(result.total_count).toBeGreaterThanOrEqual(
            result.annotations.length,
        );
    });
});

describe('MCP year and creator filters', () => {
    it('includes first and full creator names in both search tools', async () => {
        for (const name of ['Joscha', 'Joscha Legewie']) {
            const metadata = await call('search_by_metadata', {
                author_query: name,
            });
            const topic = await call('search_by_topic', {
                topic_query: 'police stops race gender',
                author_filter: [name],
            });
            expect(metadata.results.length).toBeGreaterThan(0);
            expect(topic.results.length).toBeGreaterThan(0);
        }
    }, 120000);
    it('excludes the next year including year-only dates from metadata search', async () => {
        const unbounded = await call('search_by_metadata', {
            author_query: 'Legewie',
            limit: 25,
        });
        expect(unbounded.results.some((item: any) => item.year > 2015)).toBe(
            true,
        );
        const bounded = await call('search_by_metadata', {
            author_query: 'Legewie',
            max_year: 2015,
            limit: 25,
        });
        expect(bounded.results.length).toBeGreaterThan(0);
        expect(
            bounded.results.every(
                (item: any) => item.year != null && item.year <= 2015,
            ),
        ).toBe(true);
    }, 120000);
    it.each([{ min_year: 2020 }, { max_year: 2010 }])(
        'excludes unknown years from bounded topic search %j',
        async (bounds) => {
            const result = await call('search_by_topic', {
                topic_query: 'aggressive policing police stops race',
                limit: 25,
                ...bounds,
            });
            for (const item of result.results) {
                expect(item.year).not.toBeNull();
                if ('min_year' in bounds)
                    expect(item.year).toBeGreaterThanOrEqual(bounds.min_year!);
                else expect(item.year).toBeLessThanOrEqual(bounds.max_year!);
            }
        },
        120000,
    );
});
