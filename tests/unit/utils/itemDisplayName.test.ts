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

    describe('item types that store their title in another field', () => {
        // Zotero maps nameOfAct (statute), caseName (case) and subject (email)
        // onto the `title` base field. Reading a plain `title` finds none of
        // them, which labelled every such item "Unknown Author".
        it('names a statute by its act rather than "Unknown Author"', () => {
            const name = getItemDisplayName(item({
                firstCreator: '',
                getDisplayTitle: () => 'Clean Air Act',
            }));

            expect(name).toBe('Clean Air Act');
        });

        it('names an email by its subject', () => {
            const name = getItemDisplayName(item({
                firstCreator: '',
                getDisplayTitle: () => 'Re: sampling frame',
            }));

            expect(name).toBe('Re: sampling frame');
        });

        it('still says "Unknown Author" when there is no title of any kind', () => {
            const name = getItemDisplayName(item({ firstCreator: '' }));

            expect(name).toBe('Unknown Author');
        });

        it('reads the base-mapped title when getDisplayTitle is unavailable', () => {
            // Some callers hand in item-like objects without the method.
            const name = getItemDisplayName(item({
                firstCreator: '',
                getDisplayTitle: undefined,
                getField: (f: string, _u?: boolean, base?: boolean) =>
                    f === 'title' && base ? 'Clean Air Act' : '',
            }));

            expect(name).toBe('Clean Air Act');
        });
    });

    describe('item types that date from another field', () => {
        it('dates a case from dateDecided', () => {
            // `date` maps from dateDecided (case), issueDate (patent) and
            // dateEnacted (statute); a plain read leaves them all undated.
            const name = getItemDisplayName(item({
                firstCreator: 'Smith',
                getField: (f: string, _u?: boolean, base?: boolean) =>
                    f === 'date' && base ? '2024-04-01' : '',
            }));

            expect(name).toBe('Smith 2024');
        });
    });
});
