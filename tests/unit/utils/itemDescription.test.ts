/**
 * `getItemDescription` — the second line under an item's display name.
 *
 * It replaces a rendered CSL bibliography entry, which cost hundreds of
 * milliseconds per row, so the bar is that it stays informative across the
 * whole item-type vocabulary — not just journal articles, whose fields are the
 * ones a naive implementation happens to read.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { getItemDescription } from '../../../src/utils/itemDescription';
import { getItemDisplayName } from '../../../src/utils/itemDisplayName';

/**
 * An item whose fields come from a map, resolving base fields the way Zotero
 * does: `getField(name, false, true)` falls back to whichever type-specific
 * field maps onto `name`.
 */
const BASE_FIELD_MAP: Record<string, string[]> = {
    publicationTitle: ['bookTitle', 'proceedingsTitle', 'websiteTitle', 'blogTitle', 'encyclopediaTitle'],
    publisher: ['university', 'institution', 'repository', 'company', 'distributor', 'label', 'network'],
    type: ['thesisType', 'reportType', 'genre', 'presentationType', 'manuscriptType', 'mapType'],
    number: ['patentNumber', 'docketNumber', 'reportNumber', 'billNumber', 'publicLawNumber', 'archiveID'],
    date: ['dateDecided', 'issueDate', 'dateEnacted'],
    place: ['repositoryLocation'],
};

function item(itemType: string, fields: Record<string, string> = {}, overrides: Record<string, any> = {}): any {
    return {
        itemType,
        isNote: () => false,
        isAnnotation: () => false,
        isAttachment: () => false,
        isRegularItem: () => true,
        parentItem: null,
        firstCreator: 'Author',
        getNote: () => '',
        getNoteTitle: () => '',
        getDisplayTitle: () => fields.title ?? '',
        getField: (name: string, _unformatted?: boolean, includeBaseMapped?: boolean) => {
            if (fields[name]) return fields[name];
            if (includeBaseMapped) {
                for (const mapped of BASE_FIELD_MAP[name] ?? []) {
                    if (fields[mapped]) return fields[mapped];
                }
            }
            return '';
        },
        ...overrides,
    };
}

beforeEach(() => {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        ItemTypes: { getLocalizedString: (type: string) => ({ patent: 'Patent', case: 'Case', document: 'Document' })[type] ?? type },
    };
});

describe('getItemDescription', () => {
    it('describes a journal article by title and publication', () => {
        const description = getItemDescription(item('journalArticle', {
            title: 'The High School Environment',
            publicationTitle: 'Sociology of Education',
            volume: '87',
            issue: '4',
            pages: '259-280',
        }));

        expect(description).toBe('The High School Environment, Sociology of Education, 87(4), 259-280');
    });

    describe('generalizes past journal articles via base fields', () => {
        it('describes a book by its publisher and place', () => {
            const description = getItemDescription(item('book', {
                title: 'Bowling Alone',
                publisher: 'Simon & Schuster',
                place: 'New York',
            }));

            expect(description).toBe('Bowling Alone, Simon & Schuster: New York');
        });

        it('describes a book section by the book it is in', () => {
            // bookTitle maps onto publicationTitle, so no book-specific branch.
            const description = getItemDescription(item('bookSection', {
                title: 'A Chapter',
                bookTitle: 'An Edited Volume',
                pages: '11-30',
            }));

            expect(description).toBe('A Chapter, An Edited Volume, 11-30');
        });

        it('describes a thesis by its type and university', () => {
            // thesisType -> type, university -> publisher.
            const description = getItemDescription(item('thesis', {
                title: 'An Inquiry',
                thesisType: 'PhD dissertation',
                university: 'Harvard University',
                place: 'Cambridge',
            }));

            expect(description).toBe('An Inquiry, PhD dissertation, Harvard University: Cambridge');
        });

        it('describes a report by its institution and number', () => {
            const description = getItemDescription(item('report', {
                title: 'Working Paper',
                reportType: 'NBER Working Paper',
                institution: 'National Bureau of Economic Research',
                reportNumber: 'w28257',
            }));

            expect(description).toBe(
                'Working Paper, NBER Working Paper, National Bureau of Economic Research, No. w28257'
            );
        });

        it('describes a preprint by its repository', () => {
            const description = getItemDescription(item('preprint', {
                title: 'A Preprint',
                genre: 'Preprint',
                repository: 'arXiv',
                archiveID: 'arXiv:2401.12345',
            }));

            expect(description).toBe('A Preprint, Preprint, arXiv, No. arXiv:2401.12345');
        });
    });

    describe('item types Zotero does not base-map', () => {
        it('describes a legal case by court and reporter citation', () => {
            // reporterVolume/reporter/firstPage are meaningless apart, so they
            // are emitted as one unit rather than three list entries.
            const description = getItemDescription(item('case', {
                caseName: 'Roe v. Wade',
                court: 'Supreme Court of the United States',
                reporter: 'U.S.',
                reporterVolume: '410',
                firstPage: '113',
                docketNumber: '70-18',
            }, { firstCreator: '' }));

            expect(description).toBe('Supreme Court of the United States, 410 U.S. 113, No. 70-18');
        });

        it('describes a patent by issuing authority and number', () => {
            const description = getItemDescription(item('patent', {
                title: 'A Widget',
                issuingAuthority: 'United States Patent and Trademark Office',
                patentNumber: 'US1234567',
            }));

            expect(description).toBe(
                'A Widget, United States Patent and Trademark Office, No. US1234567'
            );
        });

        it('describes a statute by its code', () => {
            const description = getItemDescription(item('statute', {
                nameOfAct: 'Clean Air Act',
                code: 'United States Code',
                publicLawNumber: '91-604',
            }, { firstCreator: '' }));

            expect(description).toBe('United States Code, No. 91-604');
        });

        it('describes a hearing by its committee rather than its publisher', () => {
            // A hearing carries a committee, a legislative body and a
            // publisher; the committee is what identifies it.
            const description = getItemDescription(item('hearing', {
                title: 'A Hearing',
                committee: 'Committee on Ways and Means',
                legislativeBody: 'House of Representatives',
                publisher: 'U.S. Government Printing Office',
            }));

            expect(description).toBe('A Hearing, Committee on Ways and Means');
        });
    });

    describe('fallbacks', () => {
        it('falls back to the url when no bibliographic field resolves', () => {
            const description = getItemDescription(item('webpage', {
                title: 'A Page',
                url: 'https://example.org/a',
            }));

            expect(description).toBe('A Page, https://example.org/a');
        });

        it('falls back to the localized item type so the line is never bare', () => {
            const description = getItemDescription(item('document', { title: 'A Thing' }));

            expect(description).toBe('A Thing, Document');
        });

        it('drops the title when the display name already is the title', () => {
            // getItemDisplayName falls back to the title for a creator-less
            // item, so repeating it here would waste the line.
            const description = getItemDescription(item('report', {
                title: 'A Government Report',
                institution: 'World Bank',
            }, { firstCreator: '' }));

            expect(description).toBe('World Bank');
        });

        it('omits a base-mapped title the display name already shows', () => {
            // A statute stores its title in nameOfAct, which the display name
            // reaches through getDisplayTitle. The pairing has to hold for a
            // base-mapped title exactly as it does for a plain one.
            const statute = item('statute', {
                nameOfAct: 'Clean Air Act',
                code: 'United States Code',
            }, {
                firstCreator: '',
                getDisplayTitle: () => 'Clean Air Act',
                getField: (name: string, _u?: boolean, includeBaseMapped?: boolean) => {
                    if (name === 'title') return includeBaseMapped ? 'Clean Air Act' : '';
                    if (name === 'code') return 'United States Code';
                    return '';
                },
            });

            expect(getItemDisplayName(statute)).toBe('Clean Air Act');
            expect(getItemDescription(statute)).toBe('United States Code');
        });

        it('still describes an item with neither creator nor title', () => {
            // The display name is "Unknown Author" here, so the description is
            // the only thing left that says what the item is.
            const description = getItemDescription(item('patent', {
                issuingAuthority: 'USPTO',
            }, { firstCreator: '', getDisplayTitle: () => '' }));

            expect(description).toBe('USPTO');
        });

        it('omits the title on request', () => {
            const description = getItemDescription(
                item('journalArticle', { title: 'A Title', publicationTitle: 'A Journal' }),
                { includeTitle: false }
            );

            expect(description).toBe('A Journal');
        });

        it('truncates a long description', () => {
            const description = getItemDescription(
                item('journalArticle', { title: 'x'.repeat(500) }),
                { maxLength: 20 }
            );

            expect(description).toBe(`${'x'.repeat(20)}...`);
        });
    });

    describe('items that are not regular items', () => {
        it('describes a note by its content past the title', () => {
            const description = getItemDescription(item('note', {}, {
                isNote: () => true,
                isRegularItem: () => false,
                getNoteTitle: () => 'Meeting notes',
                getNote: () => '<p>Meeting notes</p><p>Discussed the sampling frame.</p>',
            }));

            expect(description).toBe('Discussed the sampling frame.');
        });

        it('describes an attachment by the item it hangs off', () => {
            const parent = item('journalArticle', { title: 'The Paper', date: '2014' });
            const description = getItemDescription(item('attachment', {}, {
                isAttachment: () => true,
                isRegularItem: () => false,
                parentItem: parent,
            }));

            expect(description).toBe('Attached to Author 2014');
        });

        it('marks a parentless attachment as standalone', () => {
            const description = getItemDescription(item('attachment', {}, {
                isAttachment: () => true,
                isRegularItem: () => false,
                parentItem: null,
            }));

            expect(description).toBe('Standalone attachment');
        });

        it('describes an annotation by the work it sits in, not its attachment', () => {
            const work = item('journalArticle', { title: 'The Paper', date: '2014' });
            const attachment = item('attachment', {}, {
                isAttachment: () => true,
                isRegularItem: () => false,
                parentItem: work,
            });
            const description = getItemDescription(item('annotation', {}, {
                isAnnotation: () => true,
                isRegularItem: () => false,
                parentItem: attachment,
            }));

            expect(description).toBe('annotation in Author 2014');
        });
    });
});
