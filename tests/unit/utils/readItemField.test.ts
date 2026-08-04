import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1]) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

import {
    isReadableItemField,
    readItemField,
} from '../../../src/services/agentDataProvider/utils';

/**
 * Zotero's primary-data column names, as reported by
 * `Zotero.Items.primaryFields`. Only four of these may be read by name; the
 * rest are device-local or internal and must stay unreadable.
 */
const PRIMARY_FIELDS = [
    'itemID', 'itemTypeID', 'dateAdded', 'dateModified', 'libraryID', 'key',
    'version', 'clientVersion', 'synced', 'createdByUserID', 'lastModifiedByUserID',
    'firstCreator', 'sortCreator', 'deleted', 'inPublications', 'parentID', 'parentKey',
    'attachmentCharset', 'attachmentLinkMode', 'attachmentContentType', 'attachmentPath',
    'attachmentSyncState', 'attachmentSyncedModificationTime', 'attachmentSyncedHash',
    'attachmentLastProcessedModificationTime', 'attachmentLastRead',
    'feedItemGUID', 'feedItemReadTime', 'feedItemTranslatedTime',
];

const ALLOWED_PRIMARY_FIELDS = ['dateAdded', 'dateModified', 'key', 'firstCreator'];

/** Field values a real journalArticle would return, keyed by field name. */
const ITEM_DATA: Record<string, string> = {
    title: 'From Causes to Events',
    date: '1994-00-00 1994',
    publicationTitle: 'Sociological Methods & Research',
    DOI: '10.1177/0049124192020004002',
    dateAdded: '2025-03-27 16:59:15',
    dateModified: '2026-05-29 00:40:47',
    key: 'ITEMKEY1',
    firstCreator: 'Abbott',
};

function makeItem(overrides: Record<string, any> = {}) {
    return {
        itemType: 'journalArticle',
        getCreators: vi.fn(() => [{ lastName: 'Abbott', firstName: 'Andrew' }]),
        getField: vi.fn((field: string) => ITEM_DATA[field] ?? ''),
        ...overrides,
    } as any;
}

describe('isReadableItemField', () => {
    beforeEach(() => {
        (globalThis as any).Zotero.Items = {
            primaryFields: PRIMARY_FIELDS,
            isPrimaryField: (field: string) => PRIMARY_FIELDS.includes(field),
        };
    });

    it.each(['itemType', 'creator', 'creators', 'year'])(
        'accepts the non-itemData alias %s',
        (field) => {
            expect(isReadableItemField(field)).toBe(true);
        }
    );

    it.each(['title', 'date', 'publicationTitle', 'DOI'])(
        'accepts the itemData field %s',
        (field) => {
            expect(isReadableItemField(field)).toBe(true);
        }
    );

    it.each(ALLOWED_PRIMARY_FIELDS)('accepts the allowlisted primary field %s', (field) => {
        expect(isReadableItemField(field)).toBe(true);
    });

    it.each(['bogusField', 'tag', 'collection', 'note', 'unfiled', 'retracted', ''])(
        'rejects the unknown name %s',
        (field) => {
            expect(isReadableItemField(field)).toBe(false);
        }
    );

    // Field names arrive over the wire and Zotero looks them up in a plain
    // object, so an inherited key must not resolve to a usable field ID.
    it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
        'rejects the inherited Object key %s',
        (field) => {
            expect(isReadableItemField(field)).toBe(false);
        }
    );

    // Device-local and internal columns are the reason the primary-field rule is
    // an allowlist: `libraryID`, `itemTypeID` and `parentID` all read as plain
    // integers that mean nothing on another install.
    it('rejects every primary field outside the allowlist', () => {
        const leaked = PRIMARY_FIELDS
            .filter(field => !ALLOWED_PRIMARY_FIELDS.includes(field))
            .filter(isReadableItemField);
        expect(leaked).toEqual([]);
    });

    it.each(['id', 'itemID', 'libraryID', 'itemTypeID', 'parentID'])(
        'rejects the non-portable identifier %s',
        (field) => {
            expect(isReadableItemField(field)).toBe(false);
        }
    );
});

describe('readItemField', () => {
    beforeEach(() => {
        (globalThis as any).Zotero.Items = {
            primaryFields: PRIMARY_FIELDS,
            isPrimaryField: (field: string) => PRIMARY_FIELDS.includes(field),
        };
    });

    it('resolves itemType without touching getField', () => {
        const item = makeItem();
        expect(readItemField(item, 'itemType')).toBe('journalArticle');
        expect(item.getField).not.toHaveBeenCalled();
    });

    it('resolves creator and creators from getCreators', () => {
        const item = makeItem();
        expect(readItemField(item, 'creator')).toBe('Abbott');
        expect(readItemField(item, 'creators')).toBe('Abbott');
        expect(item.getField).not.toHaveBeenCalled();
    });

    it('resolves year from the date field', () => {
        expect(readItemField(makeItem(), 'year')).toBe(1994);
    });

    it('reads an itemData field with base mapping enabled', () => {
        const item = makeItem();
        expect(readItemField(item, 'publicationTitle')).toBe('Sociological Methods & Research');
        expect(item.getField).toHaveBeenCalledWith('publicationTitle', false, true);
    });

    it('reads an allowlisted primary field without base mapping', () => {
        const item = makeItem();
        expect(readItemField(item, 'dateAdded')).toBe('2025-03-27 16:59:15');
        expect(item.getField).toHaveBeenCalledWith('dateAdded');
    });

    it('returns undefined for unknown names', () => {
        const item = makeItem();
        expect(readItemField(item, 'bogusField')).toBeUndefined();
        expect(readItemField(item, '')).toBeUndefined();
    });

    it('returns undefined for non-portable identifiers', () => {
        const item = makeItem();
        for (const field of ['id', 'itemID', 'libraryID', 'itemTypeID', 'parentID']) {
            expect(readItemField(item, field)).toBeUndefined();
        }
    });

    // The whole point of the helper: `getField(name, false, true)` throws for a
    // name that is not an itemData field, and plugin patches on
    // `Zotero.Item.prototype.getField` log every such throw and retry the call.
    // No rejected name may reach it.
    it('never passes a rejected name to getField', () => {
        const item = makeItem();
        const rejected = [...PRIMARY_FIELDS, 'id', 'bogusField', 'tag', 'collection', 'note', 'unfiled']
            .filter(field => !isReadableItemField(field));

        for (const field of rejected) {
            readItemField(item, field);
        }

        expect(item.getField).not.toHaveBeenCalled();
        expect(rejected).toContain('libraryID');
    });
});
