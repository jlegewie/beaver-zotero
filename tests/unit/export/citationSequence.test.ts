import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn(() => undefined), setPref: vi.fn() }));

import { CitationService } from '../../../src/services/CitationService';

/** A citeproc stand-in that records what it is asked to format. */
function stubEngine(format: string, calls: any[]) {
    const engine: any = {
        opt: { class: 'note' },
        sys: { retrieveItem: vi.fn((id: number) => ({ id, type: 'book', title: `Library ${id}` })) },
        rebuildProcessorState: vi.fn((citations: any[]) => {
            calls.push({ format, citations, retrieved: citations.flatMap((c: any) => c.citationItems.map((i: any) => engine.sys.retrieveItem(i.id))) });
            return citations.map((c: any) => [c.citationID, c.properties.noteIndex, `${format}:${c.citationItems.map((i: any) => i.id).join('+')}`]);
        }),
        makeBibliography: vi.fn(() => [{ hangingindent: 1, linespacing: 2, entryspacing: 0 }, ['<div class="csl-entry">E</div>']]),
    };
    return engine;
}

describe('CitationService.formatCitationSequence', () => {
    const calls: any[] = [];
    const style = { styleID: 'http://www.zotero.org/styles/test', class: 'note', hasBibliography: true, getCiteProc: vi.fn((_locale: string, format: string) => stubEngine(format, calls)) };

    beforeEach(() => {
        vi.clearAllMocks();
        calls.length = 0;
        (Zotero as any).Styles = { get: vi.fn((id: string) => (id === style.styleID ? style : null)) };
        (Zotero as any).Cite = { getBibliographyFormatParameters: vi.fn(() => ({ indent: 720, firstLineIndent: -720, lineSpacing: 480, entrySpacing: 0, tabStops: [] })) };
    });

    it('formats all clusters as one sequence, serving embedded items to the processor', () => {
        const service = new CitationService({ log: vi.fn() });
        const result = service.formatCitationSequence({
            styleId: style.styleID,
            locale: 'de-DE',
            clusters: [
                { items: [{ id: 1, locator: '3' }], noteIndex: 1 },
                { items: [], noteIndex: 0 },
                { items: [{ id: 'beaver-external-W1' }, { id: 1 }], noteIndex: 2 },
            ],
            embeddedItems: { 'beaver-external-W1': { type: 'article', title: 'External' } },
        });

        const html = calls.find(call => call.format === 'html');
        expect(html.citations).toEqual([
            { citationID: 'c0', citationItems: [{ id: 1, locator: '3', label: 'page' }], properties: { noteIndex: 1 } },
            { citationID: 'c2', citationItems: [{ id: 'beaver-external-W1' }, { id: 1 }], properties: { noteIndex: 2 } },
        ]);
        expect(html.retrieved).toContainEqual({ type: 'article', title: 'External', id: 'beaver-external-W1' });
        expect(result.clusters).toEqual([
            { html: 'html:1', rtf: 'rtf:1' },
            null,
            { html: 'html:beaver-external-W1+1', rtf: 'rtf:beaver-external-W1+1' },
        ]);
        expect(result.styleClass).toBe('note');
        expect(result.locale).toBe('de-DE');
        expect(Object.keys(result.itemData).sort()).toEqual(['1', 'beaver-external-W1']);
        expect(result.bibliography?.entries).toEqual(['<div class="csl-entry">E</div>']);
        expect(result.bibliography?.layout.indent).toBe(720);
    });

    it('falls back to the default style when the requested one is not installed', () => {
        const service = new CitationService({ log: vi.fn() });
        expect(service.resolveStyle('http://www.zotero.org/styles/missing').style).toBeNull();
        expect(Zotero.Styles.get).toHaveBeenCalledWith('http://www.zotero.org/styles/chicago-author-date');
    });
});
