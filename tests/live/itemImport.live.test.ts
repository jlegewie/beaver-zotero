/**
 * Live tests for create_items v2 item import (`import_item`) against a running Zotero.
 *
 * Covers:
 *   - every internal Zotero API item import relies on passes its probe (a Zotero
 *     update that breaks one fails here, not for users);
 *   - dry-run resolution with real translators: DOI, ISBN, arXiv, PMID, an
 *     invalid DOI, model metadata, web pages, a dead host and a private host;
 *   - validate/execute of an `import_item` action through the agent-action
 *     endpoints, the duplicate check on a second resolution, and undo;
 *   - local-path authorization with an injected folder.
 *
 * Network-dependent cases (translators, web pages) need internet access.
 * Prerequisites: dev or staging build running + authenticated; the personal
 * library searchable in Beaver. Run: npm run test:live -- itemImport
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

interface Resolved {
    key: string;
    status: 'resolved' | 'already_in_library' | 'failed';
    item?: Record<string, any>;
    method?: string;
    translator?: string;
    snapshot_url?: string;
    attachment_urls?: Array<{ url: string; mime_type?: string }>;
    existing_item?: { library_id: number; zotero_key: string };
    warnings?: string[];
    error?: { code: string; message: string };
}

function spec(key: string, extra: Record<string, unknown>) {
    return { key, source: { kind: 'identifier', input: key }, ...extra };
}

async function resolve(items: unknown[], extra: Record<string, unknown> = {}): Promise<Record<string, Resolved>> {
    const response = await post<{ items?: Resolved[]; error?: string }>('/beaver/test/item-import-resolve', { items, ...extra });
    expect(response.error).toBeUndefined();
    return Object.fromEntries((response.items ?? []).map((item) => [item.key, item]));
}

let available: boolean;
const created: Array<{ library_id: number; zotero_key: string; library_ref?: string }> = [];
let folder: string | undefined;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) console.warn('\n⚠  Zotero not available — itemImport live tests will be skipped.\n');
});

afterAll(async () => {
    for (const ref of created) {
        await post('/beaver/test/item-import-write', { undo: ref }).catch(() => undefined);
    }
    if (folder) rmSync(folder, { recursive: true, force: true });
});

describe('internal Zotero API probes', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('reports every API item import relies on as available', async () => {
        const response = await post<{ apis: Record<string, { available: boolean; reason?: string }> }>(
            '/beaver/test/item-import-capabilities', {},
        );
        const unavailable = Object.entries(response.apis).filter(([, status]) => !status.available);
        expect(unavailable).toEqual([]);
    });
});

describe('resolution with real translators', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('resolves identifiers and reports a bad DOI without failing the batch', async () => {
        const results = await resolve([
            spec('doi', { identifier: { type: 'doi', value: '10.1038/nature12373' } }),
            spec('isbn', { identifier: { type: 'isbn', value: '9780262046824' } }),
            spec('arxiv', { identifier: { type: 'arxiv', value: '2106.09685' } }),
            spec('pmid', { identifier: { type: 'pmid', value: '23903748' } }),
            spec('bad', { identifier: { type: 'doi', value: '10.9999/beaver-does-not-exist' } }),
        ], { skip_duplicate_check: true });

        expect(results.doi.status).toBe('resolved');
        expect(results.doi.item?.itemType).toBe('journalArticle');
        expect(results.doi.method).toBe('translator');
        expect(results.isbn.item?.itemType).toBe('book');
        expect(results.arxiv.item?.itemType).toBe('preprint');
        expect(results.arxiv.attachment_urls?.some((a) => a.mime_type === 'application/pdf')).toBe(true);
        expect(results.pmid.item?.title).toMatch(/thermometry/i);
        expect(results.bad.status).toBe('failed');
        expect(results.bad.error?.code).toBe('not_found');
    }, 90_000);

    it('normalizes model metadata, remapping base fields and reporting fields moved to Extra', async () => {
        const results = await resolve([{
            key: 'metadata[0]',
            source: { kind: 'metadata', input: 'metadata[0]' },
            item: { itemType: 'report', title: 'Beaver Live Grey Report', university: 'Somewhere', court: 'Supreme Court', creators: [{ name: 'World Bank' }] },
        }, {
            key: 'metadata[1]',
            source: { kind: 'metadata', input: 'metadata[1]' },
            item: { itemType: 'notAType', title: 'x' },
        }], { skip_duplicate_check: true });
        expect(results['metadata[0]'].status).toBe('resolved');
        expect(results['metadata[0]'].method).toBe('model_metadata');
        expect(results['metadata[0]'].item?.creators?.[0]).toMatchObject({ creatorType: 'author', name: 'World Bank' });
        expect(results['metadata[0]'].item?.institution).toBe('Somewhere');
        expect(results['metadata[0]'].warnings).toContain('university stored as institution');
        expect(results['metadata[0]'].warnings?.join(' ')).toMatch(/moved to Extra.*Court/i);
        expect(results['metadata[1]'].error?.code).toBe('invalid_metadata');
    });

    it('translates web pages and refuses dead and private hosts', async () => {
        const results = await resolve([
            { key: 'arxiv-page', source: { kind: 'url', input: 'u1' }, url: 'https://arxiv.org/abs/2106.09685' },
            { key: 'wiki', source: { kind: 'url', input: 'u2' }, url: 'https://en.wikipedia.org/wiki/Zotero' },
            { key: 'dead', source: { kind: 'url', input: 'u3' }, url: 'https://beaver-live-test.invalid/' },
            { key: 'private', source: { kind: 'url', input: 'u4' }, url: 'http://127.0.0.1:1/' },
        ], { skip_duplicate_check: true });
        expect(results['arxiv-page'].method).toBe('web_translator');
        expect(results['arxiv-page'].item?.itemType).toBe('preprint');
        expect(results.wiki.status).toBe('resolved');
        expect(results.wiki.snapshot_url).toContain('wikipedia.org');
        expect(results.dead.error?.code).toBe('unreachable');
        expect(results.private.error?.code).toBe('url_not_allowed');
    }, 90_000);
});

describe('web pages that redirect or check the browser first', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('refuses redirects to private-network addresses, literal or resolved', async () => {
        const redirect = (target: string) => `https://httpbin.org/redirect-to?url=${encodeURIComponent(target)}`;
        const results = await resolve([
            { key: 'literal', source: { kind: 'url', input: 'a' }, url: redirect('http://127.0.0.1/') },
            { key: 'resolved', source: { kind: 'url', input: 'b' }, url: redirect('http://localtest.me/') },
            { key: 'public', source: { kind: 'url', input: 'c' }, url: redirect('https://en.wikipedia.org/wiki/Zotero') },
        ], { skip_duplicate_check: true });
        expect(results.literal.error?.code).toBe('url_not_allowed');
        expect(results.resolved.error?.code).toBe('url_not_allowed');
        expect(results.public.status).toBe('resolved');
    }, 90_000);

    it('translates NCBI pages instead of saving their interstitial', async () => {
        const results = await resolve([
            { key: 'pubmed', source: { kind: 'url', input: 'a' }, url: 'https://pubmed.ncbi.nlm.nih.gov/23903748/' },
            { key: 'pmc', source: { kind: 'url', input: 'b' }, url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4221854/' },
        ], { skip_duplicate_check: true });
        expect(results.pubmed.item?.itemType).toBe('journalArticle');
        expect(results.pmc.item?.itemType).toBe('journalArticle');
    }, 90_000);
});

describe('validate, execute, duplicate check and undo', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('creates an approved item, then reports it as already in the library', async () => {
        const title = `Beaver Live Import ${Date.now()}`;
        const metadata = { itemType: 'report', title, creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }], date: '2026' };
        const validation = await post<any>('/beaver/agent-action/validate', {
            action_type: 'import_item',
            action_data: {
                deadline_ms: 20_000,
                items: [{ key: 'metadata[0]', source: { kind: 'metadata', input: 'metadata[0]' }, item: metadata }],
            },
        });
        expect(validation.valid).toBe(true);
        expect(validation.current_value.library_ref).toBe('u');
        const resolved = validation.current_value.items[0];
        expect(resolved.status).toBe('resolved');

        const execution = await post<any>('/beaver/agent-action/execute', {
            action_type: 'import_item',
            action_data: {
                library_ref: 'u',
                tags: ['beaver-live-import'],
                source: { kind: 'metadata', input: 'metadata[0]' },
                item: resolved.item,
                resolution: { method: 'model_metadata' },
            },
        });
        if (execution.result_data) created.push(execution.result_data);
        expect(execution.success).toBe(true);
        expect(execution.result_data.library_ref).toBe('u');
        // No DOI, URL or candidates: there is nowhere to look for a PDF.
        expect(execution.result_data.attachment_status).toBe('none');

        const again = await resolve([{ key: 'm', source: { kind: 'metadata', input: 'm' }, item: metadata }]);
        expect(again.m.status).toBe('already_in_library');
        expect(again.m.existing_item?.zotero_key).toBe(execution.result_data.zotero_key);

        const undo = await post<any>('/beaver/test/item-import-write', { undo: execution.result_data });
        expect(undo.undone).toBe(true);
        created.pop();
        const afterUndo = await resolve([{ key: 'm', source: { kind: 'metadata', input: 'm' }, item: metadata }]);
        expect(afterUndo.m.status).toBe('resolved');
    }, 60_000);
});

describe('local path authorization', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('accepts only PDF/EPUB files inside an authorized folder', async () => {
        folder = mkdtempSync(join(tmpdir(), 'beaver-import-'));
        const pdf = join(folder, 'paper.pdf');
        writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
        writeFileSync(join(folder, 'notes.txt'), 'plain text');
        const metadata = { itemType: 'report', title: 'Path import' };
        const items = [
            { key: 'inside', source: { kind: 'metadata', input: 'inside' }, item: metadata, file: { path: pdf } },
            { key: 'dotdot', source: { kind: 'metadata', input: 'dotdot' }, item: metadata, file: { path: `${folder}/../${folder.split('/').pop()}/paper.pdf` } },
            { key: 'txt', source: { kind: 'metadata', input: 'txt' }, item: metadata, file: { path: join(folder, 'notes.txt') } },
            { key: 'outside', source: { kind: 'metadata', input: 'outside' }, item: metadata, file: { path: '/etc/hosts' } },
        ];

        const denied = await resolve(items.slice(0, 1), { skip_duplicate_check: true });
        expect(denied.inside.error?.code).toBe('path_not_authorized');

        const results = await resolve(items, { skip_duplicate_check: true, authorized_folders: [folder] });
        expect(results.inside.status).toBe('resolved');
        expect(results.dotdot.error?.code).toBe('path_not_authorized');
        expect(results.txt.error?.code).toBe('unsupported_type');
        expect(results.outside.error?.code).toBe('path_not_authorized');
    });
});
