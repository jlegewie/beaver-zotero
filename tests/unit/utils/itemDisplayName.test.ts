/**
 * `getItemDisplayName` — the canonical short label for an item.
 *
 * It is what chips, tool-call headers and the compact library projections all
 * show, so every item type a client can be handed has to come out with
 * something a person recognizes.
 */
import { describe, expect, it } from 'vitest';
import { getItemDisplayName } from '../../../src/utils/itemDisplayName';

function item(overrides: Record<string, any> = {}): any {
    return {
        isNote: () => false,
        isAnnotation: () => false,
        isAttachment: () => false,
        parentItem: null,
        firstCreator: '',
        getField: () => '',
        getNoteTitle: () => '',
        getDisplayTitle: () => '',
        ...overrides,
    };
}

describe('getItemDisplayName', () => {
    it('labels a regular item with its creator string and year', () => {
        const name = getItemDisplayName(item({
            firstCreator: 'Legewie and DiPrete',
            getField: (field: string) => (field === 'date' ? '2014-05-01' : ''),
        }));

        expect(name).toBe('Legewie and DiPrete 2014');
    });

    it('labels an annotation with its highlighted text', () => {
        // An annotation has no creators and no title, so without its own branch
        // it falls through to the creator path and reads "Unknown Author".
        const name = getItemDisplayName(item({
            isAnnotation: () => true,
            getDisplayTitle: () => 'outcomes are across the categories',
        }));

        expect(name).toBe('outcomes are across ...');
    });

    it('falls back to a type label for an annotation with no text', () => {
        const name = getItemDisplayName(item({ isAnnotation: () => true }));

        expect(name).toBe('Annotation');
    });

    it('marks a grouped selection with its count', () => {
        const name = getItemDisplayName(item({ firstCreator: 'Legewie' }), 3);

        expect(name).toBe('Legewie (3)');
    });
});
