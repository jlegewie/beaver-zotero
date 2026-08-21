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

import { getCreatorTypeInfo } from '../../../src/utils/zoteroUtils';

/**
 * Mirrors Zotero's schema for the types under test. Creator type order matches
 * Zotero's own (the primary is NOT necessarily first — that is the whole
 * reason the primary has to be reported separately).
 */
const TYPE_IDS: Record<string, number> = {
    patent: 100,
    journalArticle: 101,
    hearing: 102,
    attachment: 103,
    unknown: 104,
};

const CREATOR_TYPE_IDS: Record<string, number> = {
    contributor: 1,
    inventor: 2,
    attorneyAgent: 3,
    author: 4,
    editor: 5,
    translator: 6,
    reviewedAuthor: 7,
};

const TYPES_FOR_ITEM_TYPE: Record<number, string[]> = {
    [TYPE_IDS.patent]: ['contributor', 'inventor', 'attorneyAgent'],
    [TYPE_IDS.journalArticle]: ['author', 'contributor', 'editor', 'translator', 'reviewedAuthor'],
    [TYPE_IDS.hearing]: ['contributor'],
    [TYPE_IDS.attachment]: [],
};

const PRIMARY_FOR_ITEM_TYPE: Record<number, string> = {
    [TYPE_IDS.patent]: 'inventor',
    [TYPE_IDS.journalArticle]: 'author',
    [TYPE_IDS.hearing]: 'contributor',
};

describe('getCreatorTypeInfo', () => {
    const Z = () => (globalThis as any).Zotero;
    let savedCreatorTypes: any;

    beforeEach(() => {
        savedCreatorTypes = Z().CreatorTypes;
        Z().CreatorTypes = {
            getTypesForItemType: vi.fn((itemTypeID: number) => {
                const names = TYPES_FOR_ITEM_TYPE[itemTypeID];
                if (!names) throw new Error(`Invalid item type ${itemTypeID}`);
                return names.map(name => ({ id: CREATOR_TYPE_IDS[name], name }));
            }),
            getPrimaryIDForType: vi.fn((itemTypeID: number) => {
                const name = PRIMARY_FOR_ITEM_TYPE[itemTypeID];
                return name ? CREATOR_TYPE_IDS[name] : false;
            }),
            getName: vi.fn((id: number) =>
                Object.keys(CREATOR_TYPE_IDS).find(k => CREATOR_TYPE_IDS[k] === id) ?? ''
            ),
        };
    });

    afterEach(() => {
        Z().CreatorTypes = savedCreatorTypes;
    });

    it("reports the primary creator type for types where 'author' is invalid", () => {
        const info = getCreatorTypeInfo(TYPE_IDS.patent);
        expect(info).toEqual({
            valid: ['contributor', 'inventor', 'attorneyAgent'],
            primary: 'inventor',
        });
        // The primary is not simply the first entry — callers must read `primary`.
        expect(info!.valid[0]).not.toBe(info!.primary);
        expect(info!.valid).not.toContain('author');
    });

    it("reports 'author' as primary for types that use it", () => {
        const info = getCreatorTypeInfo(TYPE_IDS.journalArticle);
        expect(info?.primary).toBe('author');
        expect(info?.valid).toContain('author');
    });

    it('reports a single-type vocabulary', () => {
        expect(getCreatorTypeInfo(TYPE_IDS.hearing)).toEqual({
            valid: ['contributor'],
            primary: 'contributor',
        });
    });

    it('returns null for item types that take no creators', () => {
        expect(getCreatorTypeInfo(TYPE_IDS.attachment)).toBeNull();
    });

    it('returns null instead of throwing for an unknown item type', () => {
        expect(getCreatorTypeInfo(TYPE_IDS.unknown)).toBeNull();
    });

    it('keeps the valid list when no primary is defined', () => {
        Z().CreatorTypes.getPrimaryIDForType = vi.fn(() => false);
        expect(getCreatorTypeInfo(TYPE_IDS.patent)).toEqual({
            valid: ['contributor', 'inventor', 'attorneyAgent'],
            primary: null,
        });
    });

    it('keeps the valid list when the primary lookup throws', () => {
        Z().CreatorTypes.getPrimaryIDForType = vi.fn(() => {
            throw new Error('Primary creator types not yet loaded');
        });
        expect(getCreatorTypeInfo(TYPE_IDS.patent)).toEqual({
            valid: ['contributor', 'inventor', 'attorneyAgent'],
            primary: null,
        });
    });
});
