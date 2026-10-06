import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/export/exportRuntime', () => ({ loadExportRuntime: vi.fn() }));
vi.mock('../../../src/services/export/exportCitations', () => ({ formatExportCitations: vi.fn() }));

import {
    buildBibliographyFile,
    distinctKey,
    entryKeys,
    withoutFileFields,
} from '../../../src/services/export/bibliographyFile';
import { bibliographyHeader, bibliographyPath } from '../../../src/services/export/instanceExport';
import type { FieldCitationItem } from '@beaver/agent-export/types';

const BUILT_IN_BIBLATEX = 'b6e39b57-8942-4d11-8259-342c46ce395f';
const BETTER_BIBLATEX = 'f895aa0d-f28e-47fe-b247-2ea77c6ed583';

type FakeItem = { id: number | null; key: string; csl?: Record<string, unknown>; isRegularItem: () => boolean };

function libraryItem(id: number, key: string, regular = true): FakeItem {
    return { id, key, isRegularItem: () => regular };
}

/** A translator stand-in: entries in item id order, keyed by the item's key (as Zotero's translators write). */
let translations: Array<{ translatorID: string; keys: string[] }> = [];
let entryKeyOverride: ((items: FakeItem[], translatorID: string) => string[]) | null = null;

class FakeExport {
    private items: FakeItem[] = [];
    private translatorID = '';
    private done: ((translate: { string: string }, success: boolean) => void) | null = null;
    setItems(items: FakeItem[]) { this.items = items.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)); }
    setTranslator(id: string) { this.translatorID = id; }
    setDisplayOptions() {}
    setHandler(_event: string, handler: (translate: { string: string }, success: boolean) => void) { this.done = handler; }
    async translate() {
        const keys = entryKeyOverride?.(this.items, this.translatorID) ?? this.items.map(item => item.key);
        translations.push({ translatorID: this.translatorID, keys });
        const string = keys.map(key => `\n@article{${key},\n\ttitle = {T},\n}\n`).join('');
        this.done?.({ string }, true);
    }
}

const LIBRARY: Record<number, FakeItem> = {
    5: libraryItem(5, 'smith_title_2004'),
    3: libraryItem(3, 'doe_other_2010'),
    9: libraryItem(9, 'attachment', false),
};

function cited(id: number | string, itemData: Record<string, unknown> = { title: 'T' }): FieldCitationItem {
    return { id, uris: [], itemData };
}

describe('entryKeys / distinctKey', () => {
    it('reads entry keys and skips non-entries', () => {
        expect(entryKeys('@comment{x}\n@string{a = "b"}\n@article{k1,\n}\n@book{ ns:k/2 ,\n}')).toEqual(['k1', 'ns:k/2']);
    });

    it('suffixes a taken key the way the translators do', () => {
        expect(distinctKey('a', new Set())).toBe('a');
        expect(distinctKey('a', new Set(['a', 'a-1']))).toBe('a-2');
    });
});

describe('withoutFileFields', () => {
    it('drops file fields with nested braces, wherever they sit in an entry', () => {
        const bib = '@article{a,\n\ttitle = {T},\n\tfile = {Full Text:/Users/me/{x}/a.pdf:application/pdf},\n\tyear = {2020},\n}\n'
            + '@article{b,\n  title = {U},\n  file = {/Users/me/b.pdf}\n}\n';
        expect(withoutFileFields(bib)).toBe('@article{a,\n\ttitle = {T},\n\tyear = {2020},\n}\n@article{b,\n  title = {U},\n}\n');
    });
});

describe('buildBibliographyFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        translations = [];
        entryKeyOverride = null;
        delete (Zotero as any).BetterBibTeX;
        (Zotero as any).Translate = { Export: FakeExport };
        (Zotero as any).Items = { getAsync: vi.fn(async (id: number) => LIBRARY[id] ?? false) };
        (Zotero as any).Item = class {
            id = null;
            key = '';
            libraryID = 0;
            isRegularItem() { return true; }
        };
        (Zotero.Utilities as any).Item = {
            itemFromCSLJSON: vi.fn((item: any, csl: any) => { item.key = csl.key; }),
        };
    });

    it('reads library keys back by item id order and gives embedded works distinct keys', async () => {
        const result = await buildBibliographyFile([
            cited(5), cited(3), cited(5), cited('beaver-external-W1', { key: 'doe_other_2010' }), cited(9, { key: 'attached_2001' }),
        ], 'biblatex');
        expect(result.keys).toEqual({
            5: 'smith_title_2004',
            3: 'doe_other_2010',
            'beaver-external-W1': 'doe_other_2010-1',
            // A standalone attachment has no entry of its own; it is written from its CSL-JSON.
            9: 'attached_2001',
        });
        expect(result.bib).toContain('@article{doe_other_2010-1,');
        // One batch for the library items, one export per embedded work.
        expect(translations.map(t => t.keys)).toEqual([['doe_other_2010', 'smith_title_2004'], ['doe_other_2010'], ['attached_2001']]);
        expect(translations.every(t => t.translatorID === BUILT_IN_BIBLATEX)).toBe(true);
    });

    it('exports items one by one when the batch entries do not line up', async () => {
        entryKeyOverride = (items) => (items.length > 1 ? ['only_one'] : items.map(item => item.key));
        const result = await buildBibliographyFile([cited(5), cited(3)], 'biblatex');
        expect(result.keys).toEqual({ 5: 'smith_title_2004', 3: 'doe_other_2010' });
    });

    it('gives works that share an explicit key distinct keys', async () => {
        entryKeyOverride = (items) => items.map(() => 'shared2020');
        const result = await buildBibliographyFile([cited(5), cited(3)], 'biblatex');
        expect(result.keys).toEqual({ 3: 'shared2020', 5: 'shared2020-1' });
        expect(result.bib).toContain('@article{shared2020-1,');
    });

    it('uses Better BibTeX keys and entries for library items when installed', async () => {
        (Zotero as any).BetterBibTeX = {
            ready: Promise.resolve(),
            KeyManager: { get: vi.fn((id: number) => ({ citationKey: `bbt${id}` })) },
        };
        entryKeyOverride = (items, translatorID) => items.map(item => (translatorID === BETTER_BIBLATEX ? `bbt${item.id}` : item.key));
        const result = await buildBibliographyFile([cited(5), cited(3)], 'biblatex');
        expect(result.keys).toEqual({ 5: 'bbt5', 3: 'bbt3' });
        expect(translations.map(t => t.translatorID)).toEqual([BETTER_BIBLATEX]);
    });

    it('falls back to Zotero\'s translator when Better BibTeX entries do not carry its keys', async () => {
        (Zotero as any).BetterBibTeX = {
            ready: Promise.resolve(),
            KeyManager: { get: vi.fn((id: number) => ({ citationKey: `bbt${id}` })) },
        };
        const result = await buildBibliographyFile([cited(5)], 'biblatex');
        expect(result.keys).toEqual({ 5: 'smith_title_2004' });
        expect(translations.map(t => t.translatorID)).toEqual([BETTER_BIBLATEX, BUILT_IN_BIBLATEX]);
    });
});

describe('bibliographyPath', () => {
    beforeEach(() => {
        vi.mocked(IOUtils.exists).mockReset();
        vi.mocked(IOUtils.readUTF8).mockReset();
    });

    it('names the file after the .tex file, without characters bibliography commands reject', async () => {
        vi.mocked(IOUtils.exists).mockResolvedValue(false);
        await expect(bibliographyPath('/out/My report #2.tex')).resolves.toBe('/out/My-report-2.bib');
        await expect(bibliographyPath('/out/Smith, 2020.tex')).resolves.toBe('/out/Smith-2020.bib');
    });

    it('replaces a .bib file only when an export of the same document wrote it', async () => {
        const files: Record<string, string> = {
            '/out/report.bib': '@article{mine,}',
            '/out/report-2.bib': `${bibliographyHeader('report.tex')}\n`,
        };
        vi.mocked(IOUtils.exists).mockImplementation(async (path: string) => path in files);
        vi.mocked(IOUtils.readUTF8).mockImplementation(async (path: string) => files[path]);
        await expect(bibliographyPath('/out/report.tex')).resolves.toBe('/out/report-2.bib');
        delete files['/out/report-2.bib'];
        await expect(bibliographyPath('/out/report.tex')).resolves.toBe('/out/report-2.bib');
        // Another document whose name maps to the same .bib name keeps its file.
        files['/out/report-2.bib'] = `${bibliographyHeader('report.tex')}\n`;
        await expect(bibliographyPath('/out/report .tex')).resolves.toBe('/out/report-3.bib');
    });
});
