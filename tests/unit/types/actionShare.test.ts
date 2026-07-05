import { describe, it, expect } from 'vitest';
import {
    serializeAction,
    toShareableActionFile,
    parseShareableAction,
    SHAREABLE_ACTION_KIND,
    SHAREABLE_ACTION_VERSION,
    SHAREABLE_ACTION_FILE_EXTENSION,
} from '../../../react/types/actionShare';
import type { Action } from '../../../react/types/actions';

const fullAction: Action = {
    id: 'custom-abc',
    title: 'Summarize',
    text: 'Summarize {{selected_items}}',
    description: 'A short summary',
    name: 'summarize',
    id_model: 'gpt-x',
    targets: ['items', 'attachment'],
    category: 'research',
    argumentHint: 'what to focus on',
    sortOrder: 42,
    deprecated: false,
    lastUsed: '2024-01-01T00:00:00.000Z',
};

describe('actionShare — schema', () => {
    it('round-trips a full action through serialize → parse', () => {
        const json = serializeAction(fullAction);
        const result = parseShareableAction(json);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Definitional fields survive
        expect(result.action.id).toBe('custom-abc');
        expect(result.action.title).toBe('Summarize');
        expect(result.action.text).toBe('Summarize {{selected_items}}');
        expect(result.action.description).toBe('A short summary');
        expect(result.action.name).toBe('summarize');
        expect(result.action.id_model).toBe('gpt-x');
        expect(result.action.targets).toEqual(['items', 'attachment']);
        expect(result.action.category).toBe('research');
        expect(result.action.argumentHint).toBe('what to focus on');
    });

    it('drops runtime/local fields (lastUsed, sortOrder, deprecated) from the file', () => {
        const file = toShareableActionFile(fullAction);
        expect(file.kind).toBe(SHAREABLE_ACTION_KIND);
        expect(file.version).toBe(SHAREABLE_ACTION_VERSION);
        expect('lastUsed' in file.action).toBe(false);
        expect('sortOrder' in file.action).toBe(false);
        expect('deprecated' in file.action).toBe(false);
    });

    it('omits absent optional fields entirely (no undefined keys)', () => {
        const minimal: Action = { id: 'x', title: 'T', text: 'P', targets: ['global'] };
        const file = toShareableActionFile(minimal);
        expect('description' in file.action).toBe(false);
        expect('name' in file.action).toBe(false);
        expect('category' in file.action).toBe(false);
        expect('argumentHint' in file.action).toBe(false);
        // A minimal action still round-trips.
        const result = parseShareableAction(serializeAction(minimal));
        expect(result.ok).toBe(true);
    });

    it('uses the .beaveraction extension constant', () => {
        expect(SHAREABLE_ACTION_FILE_EXTENSION).toBe('beaveraction');
    });

    // --- Rejections -------------------------------------------------------

    it('rejects non-JSON', () => {
        const r = parseShareableAction('not json {');
        expect(r).toEqual({ ok: false, error: expect.stringContaining('JSON') });
    });

    it('rejects a JSON array / non-object', () => {
        expect(parseShareableAction('[]').ok).toBe(false);
        expect(parseShareableAction('"a string"').ok).toBe(false);
    });

    it('rejects a file without the beaver.action kind', () => {
        const r = parseShareableAction(JSON.stringify({ version: 1, action: {} }));
        expect(r.ok).toBe(false);
    });

    it('rejects an unknown / newer version', () => {
        const r = parseShareableAction(JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 999,
            action: fullAction,
        }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/newer version/i);
    });

    it('rejects a missing title or prompt', () => {
        const base = { kind: SHAREABLE_ACTION_KIND, version: 1 };
        expect(parseShareableAction(JSON.stringify({ ...base, action: { text: 'x', targets: ['global'] } })).ok).toBe(false);
        expect(parseShareableAction(JSON.stringify({ ...base, action: { title: 'x', targets: ['global'] } })).ok).toBe(false);
    });

    it('rejects an empty or invalid targets set', () => {
        const base = { kind: SHAREABLE_ACTION_KIND, version: 1 };
        expect(parseShareableAction(JSON.stringify({ ...base, action: { title: 'T', text: 'P', targets: [] } })).ok).toBe(false);
        expect(parseShareableAction(JSON.stringify({ ...base, action: { title: 'T', text: 'P', targets: ['bogus'] } })).ok).toBe(false);
        expect(parseShareableAction(JSON.stringify({ ...base, action: { title: 'T', text: 'P' } })).ok).toBe(false);
    });

    it('rejects an unknown category', () => {
        const r = parseShareableAction(JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'], category: 'bogus' },
        }));
        expect(r.ok).toBe(false);
    });

    it('rejects a slash-command name containing whitespace', () => {
        const r = parseShareableAction(JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'], name: 'has space' },
        }));
        expect(r.ok).toBe(false);
    });

    // --- Client compatibility -------------------------------------------

    it('stamps the current client on export and accepts it on import', () => {
        const minimal: Action = { id: 'x', title: 'T', text: 'P', targets: ['global'] };
        const file = toShareableActionFile(minimal);
        expect(file.action.client).toEqual(['zotero']);
        const r = parseShareableAction(serializeAction(minimal));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.action.client).toEqual(['zotero']);
    });

    it('accepts an action whose client list includes the current client', () => {
        const r = parseShareableAction(JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'], client: ['zotero'] },
        }));
        expect(r.ok).toBe(true);
    });

    it('rejects an action whose client list excludes the current client', () => {
        const r = parseShareableAction(JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'], client: ['obsidian'] },
        }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/not compatible/i);
    });

    it('rejects an empty or malformed client list', () => {
        const base = { kind: SHAREABLE_ACTION_KIND, version: 1 };
        expect(parseShareableAction(JSON.stringify({ ...base, action: { title: 'T', text: 'P', targets: ['global'], client: [] } })).ok).toBe(false);
        expect(parseShareableAction(JSON.stringify({ ...base, action: { title: 'T', text: 'P', targets: ['global'], client: 'zotero' } })).ok).toBe(false);
        expect(parseShareableAction(JSON.stringify({ ...base, action: { title: 'T', text: 'P', targets: ['global'], client: [1] } })).ok).toBe(false);
    });

    it('treats an absent client list as compatible with any client', () => {
        const r = parseShareableAction(JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'] },
        }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.action.client).toBeUndefined();
    });

    it('honors an explicit currentClient override', () => {
        const json = JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'], client: ['zotero'] },
        });
        // A hypothetical other client is not in the list → rejected.
        expect(parseShareableAction(json, 'zotero').ok).toBe(true);
    });

    it('preserves an empty-string id (importer regenerates as needed)', () => {
        const r = parseShareableAction(JSON.stringify({
            kind: SHAREABLE_ACTION_KIND,
            version: 1,
            action: { title: 'T', text: 'P', targets: ['global'] },
        }));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.action.id).toBe('');
    });
});
