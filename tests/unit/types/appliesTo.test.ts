import { describe, it, expect } from 'vitest';
import {
    appliesToFromTargets,
    targetsFromAppliesTo,
    appliesToLabel,
    matchesAppliesToFilter,
    targetsForAppliesToFilter,
    type ActionTargetType,
} from '@beaver/agent-core/types/actions';

describe('"Applies to" model', () => {
    it('shows items, files and both as one Items choice, with "needs the file" for files only', () => {
        expect(appliesToFromTargets(['items'])).toMatchObject({ items: true, needsFile: false });
        expect(appliesToFromTargets(['items', 'attachment'])).toMatchObject({ items: true, needsFile: false });
        expect(appliesToFromTargets(['attachment'])).toMatchObject({ items: true, needsFile: true });
    });

    it('round-trips every stored shape unchanged', () => {
        const shapes: ActionTargetType[][] = [
            ['global'], ['items'], ['attachment'], ['items', 'attachment'], ['note'], ['collection'],
            ['items', 'collection'], ['items', 'collection', 'global'], ['items', 'attachment', 'note'],
        ];
        for (const targets of shapes) {
            const back = targetsFromAppliesTo(appliesToFromTargets(targets), targets);
            expect([...back].sort()).toEqual([...targets].sort());
        }
    });

    it('stores a new Items choice as paper or file, and "needs the file" as files only', () => {
        const none = { items: false, needsFile: false, notes: false, collections: false, anywhere: false };
        expect(targetsFromAppliesTo({ ...none, items: true })).toEqual(['items', 'attachment']);
        expect(targetsFromAppliesTo({ ...none, items: true, needsFile: true })).toEqual(['attachment']);
        expect(targetsFromAppliesTo({ ...none, items: true }, ['attachment'])).toEqual(['items', 'attachment']);
        expect(targetsFromAppliesTo(none)).toEqual(['global']);
    });

    it('labels target sets for the action list', () => {
        expect(appliesToLabel(['global'])).toBe('Anywhere');
        expect(appliesToLabel(['items', 'attachment'])).toBe('Items');
        expect(appliesToLabel(['attachment'])).toBe('Item files');
        expect(appliesToLabel(['items', 'collection'])).toBe('Items or collections');
        expect(appliesToLabel(['items', 'collection', 'global'])).toBe('Items, collections or anywhere');
    });

    it('filters Items to cover both papers and files', () => {
        expect(matchesAppliesToFilter(['attachment'], 'items')).toBe(true);
        expect(matchesAppliesToFilter(['items'], 'items')).toBe(true);
        expect(matchesAppliesToFilter(['collection'], 'items')).toBe(false);
        expect(matchesAppliesToFilter(['items', 'collection', 'global'], 'global')).toBe(true);
        expect(targetsForAppliesToFilter('items')).toEqual(['items', 'attachment']);
        expect(targetsForAppliesToFilter('collection')).toEqual(['collection']);
    });
});
