import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// zoteroUtils pulls in a transitive chain (sourceUtils → react atoms) at load.
// react/atoms/profile.ts calls getZoteroUserIdentifier() at module top-level, so a
// minimal Zotero.Users must exist before import; and supabaseClient throws without env.
vi.hoisted(() => {
    const Z = ((globalThis as any).Zotero = (globalThis as any).Zotero || {});
    Z.Users = Z.Users || {
        getCurrentUserID: () => 0,
        getLocalUserKey: () => 'bootstrap',
        getCurrentUsername: () => '',
        getCurrentName: () => '',
    };
});
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({ store: { get: vi.fn(), set: vi.fn(), sub: vi.fn() } }));

import { readBeaverLoc, buildBeaverCitationMeta } from '../../../src/utils/noteCitationLoc';
import { createCitationHTML } from '../../../src/utils/zoteroUtils';

/** Parse the citation object back out of the `data-citation` attribute. */
function parseCitation(html: string): any {
    const match = html.match(/data-citation="([^"]*)"/);
    if (!match) throw new Error(`No data-citation in: ${html}`);
    return JSON.parse(decodeURIComponent(match[1]));
}

function firstItem(html: string): any {
    return parseCitation(html).citationItems[0];
}

const mockItem = {
    key: 'ABCD1234',
    isAttachment: () => false,
    isRegularItem: () => true,
} as unknown as Zotero.Item;

describe('createCitationHTML — Beaver locator key', () => {
    const Z = () => (globalThis as any).Zotero;
    let saved: Record<string, any>;

    beforeEach(() => {
        saved = {
            Utilities: Z().Utilities,
            URI: Z().URI,
            EditorInstanceUtilities: Z().EditorInstanceUtilities,
        };
        Z().Utilities = {
            Item: { itemToCSLJSON: () => ({ id: 'csl-id', type: 'book', title: 'Mock Title' }) },
        };
        Z().URI = { getItemURI: () => 'http://zotero.org/users/1/items/ABCD1234' };
        Z().EditorInstanceUtilities = { formatCitation: () => '(Mock, 2024)' };
    });

    afterEach(() => {
        Z().Utilities = saved.Utilities;
        Z().URI = saved.URI;
        Z().EditorInstanceUtilities = saved.EditorInstanceUtilities;
    });

    it('records the Beaver locator token when one is supplied', () => {
        const item = firstItem(createCitationHTML(mockItem, '3', { beaverLoc: 's56-s59' }));
        expect(item.beaver).toEqual({ v: 1, loc: 's56-s59' });
        expect(readBeaverLoc(item)).toBe('s56-s59');
    });

    it('omits the Beaver key entirely when no token is supplied', () => {
        const item = firstItem(createCitationHTML(mockItem, '3'));
        expect(item).not.toHaveProperty('beaver');
        expect(readBeaverLoc(item)).toBeUndefined();
    });

    it('records the Beaver locator token even when no page locator resolved', () => {
        const item = firstItem(createCitationHTML(mockItem, undefined, { beaverLoc: 'l50' }));
        expect(item.beaver).toEqual({ v: 1, loc: 'l50' });
        expect(item).not.toHaveProperty('locator');
        expect(item).not.toHaveProperty('label');
    });

    it('uses the supplied CSL label for the locator', () => {
        const item = firstItem(createCitationHTML(mockItem, '4', { cslLabel: 'chapter' }));
        expect(item.locator).toBe('4');
        expect(item.label).toBe('chapter');
    });

    it('defaults the CSL label to "page" when none is supplied', () => {
        expect(firstItem(createCitationHTML(mockItem, '4')).label).toBe('page');
        expect(firstItem(createCitationHTML(mockItem, '4', { beaverLoc: 'page4' })).label).toBe('page');
    });
});

describe('readBeaverLoc', () => {
    it('returns the token for a well-formed meta object', () => {
        expect(readBeaverLoc({ beaver: buildBeaverCitationMeta('page5') })).toBe('page5');
    });

    it('returns undefined for null, undefined, and non-object input', () => {
        expect(readBeaverLoc(null)).toBeUndefined();
        expect(readBeaverLoc(undefined)).toBeUndefined();
        expect(readBeaverLoc('s1-s2')).toBeUndefined();
        expect(readBeaverLoc(42)).toBeUndefined();
    });

    it('returns undefined when the citation item has no Beaver key', () => {
        expect(readBeaverLoc({ uris: ['http://zotero.org/users/1/items/ABCD1234'] })).toBeUndefined();
    });

    it('returns undefined when the Beaver key is not an object', () => {
        expect(readBeaverLoc({ beaver: 's56-s59' })).toBeUndefined();
        expect(readBeaverLoc({ beaver: null })).toBeUndefined();
    });

    it('returns undefined when loc is missing or wrongly typed', () => {
        expect(readBeaverLoc({ beaver: { v: 1 } })).toBeUndefined();
        expect(readBeaverLoc({ beaver: { v: 1, loc: 5 } })).toBeUndefined();
        expect(readBeaverLoc({ beaver: { v: 1, loc: ['s1'] } })).toBeUndefined();
    });

    it('returns undefined for an empty loc string', () => {
        expect(readBeaverLoc({ beaver: { v: 1, loc: '' } })).toBeUndefined();
    });
});
