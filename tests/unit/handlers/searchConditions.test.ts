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
    const LIBRARY_ID = 1;
    let warnings: string[];
    let addCondition: ReturnType<typeof vi.fn>;

    /** Run one condition through the shared translator, naming the library. */
    const add = (condition: ZoteroSearchCondition) =>
        addSearchCondition({ addCondition } as any, condition, warnings, LOG_LABEL, LIBRARY_ID);

    const addedConditions = () => addCondition.mock.calls.map(call => call.slice(0, 3));

    beforeEach(() => {
        vi.clearAllMocks();
        warnings = [];
        addCondition = vi.fn();
        (globalThis as any).Zotero.Collections = {
            getByLibraryAndKey: vi.fn((libraryID: number, key: string) =>
                libraryID === LIBRARY_ID && key === 'ABCD2345'
                    ? { id: 77, name: 'Methods' }
                    : false),
        };
    });

    it('adds a condition naming a collection the library has', () => {
        expect(add({ field: 'collection', operator: 'is', value: 'ABCD2345' } as any)).toBe(true);
        expect(addedConditions()).toEqual([['collection', 'is', 'ABCD2345']]);
        expect(warnings).toEqual([]);
    });

    it('drops a key the library does not have, naming it', () => {
        expect(add({ field: 'collection', operator: 'is', value: 'ZZZZ9999' } as any)).toBe(false);
        expect(addedConditions()).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("value='ZZZZ9999'");
        expect(warnings[0]).toContain('list_collections');
    });

    it('drops an unknown key under isNot, which would otherwise select everything', () => {
        // Zotero compiles an unresolvable collection to a set matching nothing,
        // and negating that matches every non-annotation item — so this is the
        // case that must never reach the search.
        expect(add({ field: 'collection', operator: 'isNot', value: 'ZZZZ9999' } as any)).toBe(false);
        expect(addedConditions()).toEqual([]);
        expect(warnings[0]).toContain('whole library');
    });

    it('reads the key out of the legacy library-prefixed form', () => {
        expect(add({ field: 'collection', operator: 'is', value: '1_ABCD2345' } as any)).toBe(true);
        expect(warnings).toEqual([]);
    });

    it('skips the check when no library was named', () => {
        // Omitted entirely, not passed as undefined: a default parameter would
        // fill the latter in and the case would not be exercised.
        const added = addSearchCondition(
            { addCondition } as any,
            { field: 'collection', operator: 'is', value: 'ZZZZ9999' } as any,
            warnings,
            LOG_LABEL,
        );
        expect(added).toBe(true);
        expect(warnings).toEqual([]);
    });

    it('leaves a refused operator to be reported as an operator problem', () => {
        // Reporting the value first would send the caller to fix the wrong half
        // and cost a second round trip.
        addCondition.mockImplementation(() => { throw new Error('Invalid operator'); });
        expect(add({ field: 'collection', operator: 'contains', value: 'ZZZZ9999' } as any)).toBe(false);
        expect(warnings[0]).toContain("operator='contains'");
        expect(warnings[0]).not.toContain('list_collections');
    });

    it('lets the condition through when collection data is not loaded', () => {
        (globalThis as any).Zotero.Collections.getByLibraryAndKey = vi.fn(() => {
            throw new Error('Collection data not yet loaded');
        });
        expect(add({ field: 'collection', operator: 'is', value: 'ABCD2345' } as any)).toBe(true);
        expect(warnings).toEqual([]);
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
