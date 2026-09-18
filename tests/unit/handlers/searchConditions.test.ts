import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

import type { ZoteroSearchCondition } from '@beaver/agent-core/protocol/agentProtocol';
import { addSearchCondition } from '../../../src/services/agentDataProvider/searchConditions';

const LOG_LABEL = 'testHandler';

describe('addSearchCondition: itemType value validation', () => {
    let warnings: string[];
    let addCondition: ReturnType<typeof vi.fn>;

    /** Run one condition through the shared translator. */
    const add = (condition: ZoteroSearchCondition) =>
        addSearchCondition({ addCondition } as any, condition, warnings, LOG_LABEL);

    /** Conditions handed to the search, as [field, operator, value]. */
    const addedConditions = () => addCondition.mock.calls.map(call => call.slice(0, 3));

    /**
     * Swap in a Zotero.ItemTypes member for one case and restore it after.
     * Used to simulate item type data that is not loaded yet.
     */
    const withItemTypesMember = <T>(name: 'getID' | 'getAll', impl: () => never, run: () => T): T => {
        const itemTypes = (globalThis as any).Zotero.ItemTypes;
        const original = itemTypes[name];
        itemTypes[name] = vi.fn(impl);
        try {
            return run();
        } finally {
            itemTypes[name] = original;
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
        warnings = [];
        addCondition = vi.fn(() => 0);
    });

    it('adds a condition naming an item type that exists', () => {
        const added = add({ field: 'itemType', operator: 'is', value: 'journalArticle' });

        expect(added).toBe(true);
        expect(addedConditions()).toEqual([['itemType', 'is', 'journalArticle']]);
        expect(warnings).toEqual([]);
    });

    it('drops an unknown item type and names the rejected value', () => {
        const added = add({ field: 'itemType', operator: 'is', value: 'article' });

        expect(added).toBe(false);
        expect(addCondition).not.toHaveBeenCalled();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("field='itemType'");
        expect(warnings[0]).toContain("value='article'");
    });

    it('names real item types in the warning so the model can correct itself', () => {
        add({ field: 'itemType', operator: 'is', value: 'paper' });

        expect(warnings[0]).toContain('journalArticle');
        expect(warnings[0]).toContain('get_metadata');
    });

    it('does not reject an empty itemType value', () => {
        const added = add({ field: 'itemType', operator: 'is', value: '' });

        // An empty "is" becomes the doesNotContain form Zotero needs.
        expect(added).toBe(true);
        expect(addedConditions()).toEqual([['itemType', 'doesNotContain', '']]);
        expect(warnings).toEqual([]);
    });

    it('leaves other fields unvalidated', () => {
        const added = add({ field: 'title', operator: 'contains', value: 'article' });

        expect(added).toBe(true);
        expect(addedConditions()).toEqual([['title', 'contains', 'article']]);
        expect(warnings).toEqual([]);
    });

    it('adds the condition unchanged when the item type lookup throws', () => {
        const added = withItemTypesMember('getID', () => {
            throw new Error('Item type data not yet loaded');
        }, () => add({ field: 'itemType', operator: 'is', value: 'article' }));

        expect(added).toBe(true);
        expect(addedConditions()).toEqual([['itemType', 'is', 'article']]);
        expect(warnings).toEqual([]);
    });

    it('adds the condition unchanged when listing item types throws', () => {
        const added = withItemTypesMember('getAll', () => {
            throw new Error('Item type data not yet loaded');
        }, () => add({ field: 'itemType', operator: 'is', value: 'article' }));

        expect(added).toBe(true);
        expect(addedConditions()).toEqual([['itemType', 'is', 'article']]);
        expect(warnings).toEqual([]);
    });
});

describe('addSearchCondition: collection value validation', () => {
    let warnings: string[];
    let addCondition: ReturnType<typeof vi.fn>;
    const add = (value: string, operator = 'is', libraryID: number | undefined = 1) =>
        addSearchCondition({ addCondition } as any, { field: 'collection', operator, value } as any, warnings, LOG_LABEL, libraryID);

    beforeEach(() => {
        warnings = [];
        addCondition = vi.fn();
        (globalThis as any).Zotero.Beaver = { libraryScopeInitialized: true, searchableLibraryIds: [1] };
        (globalThis as any).Zotero.Libraries.userLibraryID = 1;
        (globalThis as any).Zotero.Collections = {
            getByLibraryAndKey: vi.fn((libraryID: number, key: string) => key === 'ABCD2345'
                ? { id: 77, name: 'Methods', libraryID, key } : false),
            getByLibrary: () => [],
        };
    });

    it.each(['ABCD2345', 'u-ABCD2345', '1-ABCD2345', '1_ABCD2345'])('normalizes %s to a native scoped key', value => {
        expect(add(value)).toBe(true);
        expect(addCondition).toHaveBeenCalledWith('collection', 'is', 'ABCD2345');
        expect(warnings).toEqual([]);
    });

    it.each(['is', 'isNot'])('fails an unresolved %s predicate instead of dropping it', operator => {
        expect(() => add('ZZZZ9999', operator)).toThrow(/Collection not found/);
        expect(addCondition).not.toHaveBeenCalled();
    });

    it('retains a negative operator while normalizing the identity', () => {
        expect(add('u-ABCD2345', 'isNot')).toBe(true);
        expect(addCondition).toHaveBeenCalledWith('collection', 'isNot', 'ABCD2345');
    });

    it('explains a native predicate rejection without losing the original reference', () => {
        addCondition.mockImplementation(() => { throw new Error('Unsupported condition'); });
        expect(() => add('u-ABCD2345', 'isNot')).toThrow(/operator="isNot".*u-ABCD2345.*Unsupported condition.*list_collections.*Do not remove/);
    });

    it('checks the library embedded in a legacy native condition', () => {
        expect(() => add('2_ABCD2345')).toThrow(/different library/);
    });

    it('refuses a missing library, invalid operator, or cold collection cache', () => {
        expect(() => addSearchCondition({ addCondition } as any,
            { field: 'collection', operator: 'is', value: 'ABCD2345' } as any, warnings, LOG_LABEL)).toThrow();
        expect(() => add('ABCD2345', 'contains')).toThrow();
        (globalThis as any).Zotero.Collections.getByLibraryAndKey.mockImplementation(() => { throw new Error('Cold cache'); });
        expect(() => add('ABCD2345')).toThrow('Cold cache');
        expect(addCondition).not.toHaveBeenCalled();
    });
});

describe('addSearchCondition: the value checks wait on the operator', () => {
    let warnings: string[];
    let addCondition: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        warnings = [];
        addCondition = vi.fn(() => { throw new Error('Invalid operator'); });
    });

    it('reports a refused operator rather than the item type name', () => {
        const added = addSearchCondition(
            { addCondition } as any,
            { field: 'itemType', operator: 'contains', value: 'boook' } as any,
            warnings,
            LOG_LABEL,
        );
        expect(added).toBe(false);
        expect(warnings[0]).toContain("operator='contains'");
        expect(warnings[0]).not.toContain('no item type has that name');
    });
});
