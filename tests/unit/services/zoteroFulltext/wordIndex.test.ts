import { afterEach, describe, expect, it, vi } from 'vitest';
import { rankWithWordIndex, type ScopeAttachment } from '../../../../src/services/zoteroFulltext/zoteroIndex';
import { buildQueryTerms } from '../../../../src/services/zoteroFulltext/text';

const attachment = (itemID: number): ScopeAttachment => ({
    itemID, libraryID: 1, key: `K${itemID}`, contentKind: 'pdf', indexed: true, partial: false, storageHash: null,
});
const scope = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(attachment);

/** Stub Zotero.Search: `results(text)` returns hits, a promise, or throws. */
function stubSearch(results: (text: string) => number[] | Promise<number[]>) {
    const searched: string[] = [];
    (globalThis as any).Zotero.Search = class {
        private text = '';
        addCondition(field: string, _op: string, value: string) {
            if (field === 'fulltextContent') this.text = value;
        }
        async search() {
            searched.push(this.text);
            return results(this.text);
        }
    };
    return searched;
}

describe('rankWithWordIndex', () => {
    afterEach(() => { delete (globalThis as any).Zotero.Search; });

    it('ranks by summed IDF and searches with the spelling as written', async () => {
        const searched = stubSearch((text) => (text === 'Müller' ? [3] : text === 'segregation' ? [3, 4] : []));
        const result = await rankWithWordIndex(buildQueryTerms('Müller segregation').terms, scope, 5, Date.now() + 5000);
        expect(searched).toEqual(['Müller', 'segregation']);
        expect(result).toEqual({ ranked: [3, 4], incomplete: false, timedOut: false });
    });

    it('reports a failed term search as incomplete', async () => {
        stubSearch((text) => { if (text === 'alpha') throw new Error('db'); return []; });
        const result = await rankWithWordIndex(buildQueryTerms('alpha beta').terms, scope, 5, Date.now() + 5000);
        expect(result).toEqual({ ranked: [], incomplete: true, timedOut: false });
    });

    it('stops at the deadline and reports the timeout', async () => {
        vi.useFakeTimers();
        try {
            const searched = stubSearch(() => new Promise<number[]>(() => undefined));
            const pending = rankWithWordIndex(buildQueryTerms('alpha beta').terms, scope, 5, Date.now() + 100);
            await vi.advanceTimersByTimeAsync(200);
            expect(await pending).toEqual({ ranked: [], incomplete: true, timedOut: true });
            expect(searched).toEqual(['alpha']);
        } finally {
            vi.useRealTimers();
        }
    });
});
