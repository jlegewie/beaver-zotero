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
