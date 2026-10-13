import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNoteCitation, createCitationHTML } from '../../../src/utils/zoteroUtils';

function regularItem(key: string) {
    return {
        key,
        parentID: false,
        isAttachment: () => false,
        isRegularItem: () => true,
    } as any;
}

describe('buildNoteCitation', () => {
    const zotero = (globalThis as any).Zotero;
    const saved = {
        URI: zotero.URI,
        Utilities: zotero.Utilities,
        EditorInstanceUtilities: zotero.EditorInstanceUtilities,
        Items: zotero.Items,
    };
    const parent = regularItem('PARENT01');

    beforeEach(() => {
        zotero.URI = { getItemURI: (item: any) => `http://zotero.org/users/1/items/${item.key}` };
        zotero.Utilities = { ...saved.Utilities, Item: { itemToCSLJSON: (item: any) => ({ id: item.key, title: 'T' }) } };
        zotero.EditorInstanceUtilities = { formatCitation: vi.fn(() => '(<span class="citation-item">Smith, 2020</span>)') };
        zotero.Items = { get: vi.fn(() => parent) };
    });

    afterEach(() => {
        Object.assign(zotero, saved);
    });

    it('stores a locator without a label, so Zotero shows the standard "p." form', () => {
        const { citation } = buildNoteCitation(regularItem('ITEM0001'), '12');

        expect(citation.citationItems[0]).toEqual({
            uris: ['http://zotero.org/users/1/items/ITEM0001'],
            itemData: { id: 'ITEM0001', title: 'T' },
            locator: '12',
        });
        expect(citation.citationItems[0]).not.toHaveProperty('label');
    });

    it('keeps a preserved label, prefix, suffix and suppress-author', () => {
        const { citation } = buildNoteCitation(regularItem('ITEM0001'), '3', {
            label: 'chapter', prefix: 'see', suffix: 'emphasis added', 'suppress-author': true,
        });

        expect(citation.citationItems[0]).toMatchObject({
            locator: '3', label: 'chapter', prefix: 'see', suffix: 'emphasis added', 'suppress-author': true,
        });
    });

    it('drops a preserved label when there is no locator for it to qualify', () => {
        const { citation } = buildNoteCitation(regularItem('ITEM0001'), undefined, { label: 'chapter' });
        expect(citation.citationItems[0]).not.toHaveProperty('label');
        expect(citation.citationItems[0]).not.toHaveProperty('locator');
    });

    it('cites the parent of a child attachment', () => {
        const attachment = { key: 'ATT00001', parentID: 5, isAttachment: () => true, isRegularItem: () => false } as any;

        const { citation } = buildNoteCitation(attachment, '4');

        expect(citation.citationItems[0].uris).toEqual(['http://zotero.org/users/1/items/PARENT01']);
    });

    it('refuses standalone attachments and other non-citable items', () => {
        const standalone = { key: 'ATT00001', parentID: false, isAttachment: () => true, isRegularItem: () => false } as any;
        const note = { key: 'NOTE0001', isAttachment: () => false, isRegularItem: () => false } as any;

        expect(() => buildNoteCitation(standalone)).toThrow('standalone attachments');
        expect(() => buildNoteCitation(note)).toThrow('not a regular item');
    });

    it('wraps the payload and formatted text in a note citation span', () => {
        const html = createCitationHTML(regularItem('ITEM0001'), '12');
        const payload = JSON.parse(decodeURIComponent(html.match(/data-citation="([^"]*)"/)![1]));

        expect(html).toMatch(/^<span class="citation" data-citation="[^"]+">\(<span class="citation-item">Smith, 2020<\/span>\)<\/span>$/);
        expect(payload.citationItems[0].locator).toBe('12');
    });
});
