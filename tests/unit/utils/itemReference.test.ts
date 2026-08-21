/**
 * `formatItemReference` — the one-line bibliographic reference used as
 * `formatted_citation`. Coverage across the item-type vocabulary, not just
 * journal articles: the cases below are where a naive field reader goes wrong.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { formatItemReference } from '../../../src/utils/itemReference';

/** Creator type ids, mirroring Zotero's `creatorTypes` table closely enough. */
const CREATOR_TYPE_IDS: Record<string, number> = {
    author: 1, editor: 2, director: 3, contributor: 4, inventor: 5, artist: 6,
    performer: 7, sponsor: 8, podcaster: 9, cartographer: 10, programmer: 11,
    interviewee: 12, presenter: 13, creator: 14, recipient: 15, interviewer: 16,
};

/** Primary creator type per item type, as `getPrimaryIDForType` reports it. */
const PRIMARY_CREATOR: Record<string, string> = {
    journalArticle: 'author', book: 'author', bookSection: 'author', report: 'author',
    thesis: 'author', webpage: 'author', dataset: 'author', standard: 'author',
    preprint: 'author', conferencePaper: 'author', statute: 'author', case: 'author',
    patent: 'inventor', artwork: 'artist', audioRecording: 'performer', bill: 'sponsor',
    podcast: 'podcaster', map: 'cartographer', computerProgram: 'programmer',
    interview: 'interviewee', presentation: 'presenter', videoRecording: 'creator',
    radioBroadcast: 'creator', film: 'director', tvBroadcast: 'director',
    hearing: 'contributor', email: 'author', instantMessage: 'author',
};

/**
 * Base-field mapping, resolving the way Zotero does: `getField(name, false,
 * true)` falls back to the type-specific field mapped onto `name`.
 */
const BASE_FIELD_MAP: Record<string, string[]> = {
    title: ['caseName', 'nameOfAct', 'subject'],
    publicationTitle: ['bookTitle', 'proceedingsTitle', 'websiteTitle', 'blogTitle', 'encyclopediaTitle', 'dictionaryTitle', 'forumTitle', 'programTitle'],
    publisher: ['university', 'institution', 'repository', 'company', 'distributor', 'label', 'network', 'studio'],
    type: ['thesisType', 'reportType', 'genre', 'presentationType', 'manuscriptType', 'mapType', 'postType', 'letterType', 'websiteType'],
    number: ['patentNumber', 'docketNumber', 'reportNumber', 'billNumber', 'publicLawNumber', 'documentNumber', 'archiveID', 'identifier', 'episodeNumber'],
    date: ['dateDecided', 'issueDate', 'dateEnacted'],
    place: ['repositoryLocation'],
    medium: ['artworkMedium', 'interviewMedium', 'audioRecordingFormat', 'videoRecordingFormat', 'audioFileType'],
};

interface FakeCreator {
    type: string;
    last: string;
    first?: string;
    /** Single-field mode: an institution stored whole in `lastName`. */
    single?: boolean;
}

function item(
    itemType: string,
    fields: Record<string, string> = {},
    creators: FakeCreator[] = [],
): any {
    return {
        itemType,
        itemTypeID: 100,
        getDisplayTitle: () => fields.title ?? fields.caseName ?? fields.nameOfAct ?? fields.subject ?? '',
        getField: (name: string, _unformatted?: boolean, includeBaseMapped?: boolean) => {
            if (fields[name]) return fields[name];
            if (includeBaseMapped) {
                for (const mapped of BASE_FIELD_MAP[name] ?? []) {
                    if (fields[mapped]) return fields[mapped];
                }
            }
            return '';
        },
        getCreators: () => creators.map(c => ({
            creatorTypeID: CREATOR_TYPE_IDS[c.type],
            fieldMode: c.single ? 1 : 0,
            lastName: c.last,
            firstName: c.first ?? '',
        })),
    };
}

beforeEach(() => {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        ItemTypes: {
            getLocalizedString: (type: string) => ({
                artwork: 'Artwork', book: 'Book', journalArticle: 'Journal Article',
                email: 'E-mail', case: 'Case',
            })[type] ?? type,
        },
        CreatorTypes: {
            getID: (name: string) => CREATOR_TYPE_IDS[name] ?? false,
            getPrimaryIDForType: () => false, // withPrimary overwrites this per test
        },
    };
});

/** Point `getPrimaryIDForType` at this item type's primary creator. */
function withPrimary<T>(itemType: string, run: () => T): T {
    const primary = PRIMARY_CREATOR[itemType];
    (globalThis as any).Zotero.CreatorTypes.getPrimaryIDForType = () =>
        (primary ? CREATOR_TYPE_IDS[primary] : false);
    return run();
}

/** Build and format an item in one step, with its primary creator type wired up. */
function cite(itemType: string, fields: Record<string, string> = {}, creators: FakeCreator[] = []): string {
    return withPrimary(itemType, () => formatItemReference(item(itemType, fields, creators)));
}

describe('formatItemReference', () => {
    it('formats a journal article as creators, year, title and locus', () => {
        expect(cite('journalArticle', {
            title: 'The High School Environment and the Gender Gap',
            publicationTitle: 'Sociology of Education',
            volume: '87',
            issue: '4',
            pages: '259-280',
            date: '2014',
        }, [
            { type: 'author', last: 'Legewie', first: 'Joscha' },
            { type: 'author', last: 'DiPrete', first: 'Thomas A.' },
        ])).toBe(
            'Legewie, Joscha; and DiPrete, Thomas A. (2014). '
            + 'The High School Environment and the Gender Gap. '
            + 'Sociology of Education, 87(4), 259-280.'
        );
    });

    describe('creators', () => {
        it('lists up to three creators before falling back to et al.', () => {
            const three = cite('journalArticle', { title: 'T', date: '2000' }, [
                { type: 'author', last: 'Burt', first: 'Ronald' },
                { type: 'author', last: 'Kilduff', first: 'Martin' },
                { type: 'author', last: 'Tasselli', first: 'Stefano' },
            ]);
            expect(three).toContain('Burt, Ronald; Kilduff, Martin; and Tasselli, Stefano (2000).');

            const four = cite('journalArticle', { title: 'T', date: '2000' }, [
                { type: 'author', last: 'He', first: 'Kaiming' },
                { type: 'author', last: 'Zhang', first: 'Xiangyu' },
                { type: 'author', last: 'Ren', first: 'Shaoqing' },
                { type: 'author', last: 'Sun', first: 'Jian' },
            ]);
            expect(four).toContain('He, Kaiming; Zhang, Xiangyu; Ren, Shaoqing; et al. (2000).');
        });

        it('strips the bidi isolates Zotero stores around creator names', () => {
            const reference = cite('journalArticle', { title: 'T', date: '2019' }, [
                { type: 'author', last: '⁨Figures⁩', first: 'Kevin' },
                { type: 'author', last: '⁨Legewie⁩', first: 'Joscha' },
            ]);

            expect(reference).toContain('Figures, Kevin; and Legewie, Joscha');
            expect(reference).not.toMatch(/[⁦-⁩]/);
        });

        it('keeps an institutional name whole rather than splitting it', () => {
            expect(cite('book', { title: 'World Development Report', date: '2021', publisher: 'World Bank' }, [
                { type: 'author', last: 'World Bank', single: true },
            ])).toBe('World Bank (2021). World Development Report. World Bank.');
        });

        it('prints the half that exists when a creator has only one name part', () => {
            expect(cite('journalArticle', { title: 'T', publicationTitle: 'J', date: '2000' }, [
                { type: 'author', last: '', first: 'Aristotle' },
            ])).toBe('Aristotle (2000). T. J.');

            expect(cite('journalArticle', { title: 'T', publicationTitle: 'J', date: '2000' }, [
                { type: 'author', last: 'Aristotle', first: '' },
            ])).toBe('Aristotle (2000). T. J.');
        });

        it('names an edited volume by its editors when it has no authors', () => {
            expect(cite('book', {
                title: 'The Handbook of Economic Sociology',
                publisher: 'Princeton University Press',
                place: 'Princeton, NJ',
                date: '2005',
            }, [
                { type: 'editor', last: 'Smelser', first: 'Neil J.' },
                { type: 'editor', last: 'Swedberg', first: 'Richard' },
            ])).toBe(
                'Smelser, Neil J.; and Swedberg, Richard (2005). The Handbook of Economic Sociology. '
                + 'Princeton University Press: Princeton, NJ.'
            );
        });
    });

    describe('conference papers', () => {
        it('places a paper by its proceedings when it has one', () => {
            expect(cite('conferencePaper', {
                title: 'Deep Residual Learning for Image Recognition',
                proceedingsTitle: 'Proceedings of the IEEE Conference on Computer Vision',
                conferenceName: 'CVPR 2016',
                pages: '770-778',
                date: '2016',
            }, [{ type: 'author', last: 'He', first: 'Kaiming' }])).toBe(
                'He, Kaiming (2016). Deep Residual Learning for Image Recognition. '
                + 'Proceedings of the IEEE Conference on Computer Vision, 770-778.'
            );
        });

        it('falls back to the conference name when there is no proceedings title', () => {
            expect(cite('conferencePaper', {
                title: 'Attention Is All You Need',
                conferenceName: 'Advances in Neural Information Processing Systems',
                date: '2017',
            }, [{ type: 'author', last: 'Vaswani', first: 'Ashish' }])).toBe(
                'Vaswani, Ashish (2017). Attention Is All You Need. '
                + 'Advances in Neural Information Processing Systems.'
            );
        });

        it('prefers the conference name over the publisher', () => {
            expect(cite('conferencePaper', {
                title: 'A Paper',
                conferenceName: 'ACM SIGCOMM',
                publisher: 'ACM Press',
                place: 'New York, NY',
                date: '2019',
            }, [{ type: 'author', last: 'Roe', first: 'Ada' }]))
                .toBe('Roe, Ada (2019). A Paper. ACM SIGCOMM.');
        });
    });

    describe('legal materials are cited by title, not by creator', () => {
        it('leads a case with its name and folds in the reporter citation', () => {
            expect(cite('case', {
                caseName: 'Roe v. Wade',
                court: 'Supreme Court of the United States',
                reporter: 'U.S.',
                reporterVolume: '410',
                firstPage: '113',
                docketNumber: '70-18',
                dateDecided: '1973-01-22',
            })).toBe(
                'Roe v. Wade (1973). Supreme Court of the United States, 410 U.S. 113, No. 70-18.'
            );
        });

        it('does not name a hearing after the witness who testified', () => {
            const reference = cite('hearing', {
                title: 'Social Media Privacy',
                committee: 'Committee on Commerce',
                documentNumber: 'S. Hrg. 115-683',
                date: '2018-04-10',
            }, [{ type: 'contributor', last: 'Zuckerberg', first: 'Mark' }]);

            expect(reference).toBe('Social Media Privacy (2018). Committee on Commerce, No. S. Hrg. 115-683.');
            expect(reference).not.toContain('Zuckerberg');
        });

        it('reads a legal code volume-first', () => {
            expect(cite('bill', {
                title: 'American Rescue Plan Act of 2021',
                code: 'Cong. Rec.',
                codeVolume: '167',
                billNumber: 'H.R. 1319',
                date: '2021-02-24',
            }, [{ type: 'sponsor', last: 'Pelosi', first: 'Nancy' }]))
                .toBe('American Rescue Plan Act of 2021 (2021). 167 Cong. Rec., No. H.R. 1319.');
        });

        it('keeps a title that already ends in an abbreviation intact', () => {
            expect(cite('case', {
                caseName: 'Doe v. Anonymous Corp.',
                reporter: 'F.3d',
                reporterVolume: '842',
                firstPage: '1229',
                dateDecided: '2016-11-15',
            })).toBe('Doe v. Anonymous Corp. (2016). 842 F.3d 1229.');
        });
    });

    describe('venue selection', () => {
        it('places a recording by its series rather than its network', () => {
            expect(cite('podcast', {
                title: 'The Halo Effect',
                seriesTitle: 'Hidden Brain',
                network: 'NPR',
                episodeNumber: '142',
                date: '2021-09-27',
            }, [{ type: 'podcaster', last: 'Vedantam', first: 'Shankar' }]))
                .toBe('Vedantam, Shankar (2021). The Halo Effect. Hidden Brain, No. 142.');
        });

        it('falls through to the distributor when the series repeats the title', () => {
            expect(cite('videoRecording', {
                title: 'Our Planet',
                seriesTitle: 'Our Planet',
                studio: 'Netflix',
                place: 'Los Angeles',
                date: '2019',
            }, [{ type: 'creator', last: 'Attenborough', first: 'David' }]))
                .toBe('Attenborough, David (2019). Our Planet. Netflix: Los Angeles.');
        });

        it('keeps the publisher when it repeats an institutional author', () => {
            expect(cite('webpage', {
                title: 'COVID-19 Pandemic',
                websiteTitle: 'World Health Organization',
                date: '2023-03-10',
            }, [{ type: 'author', last: 'World Health Organization', single: true }]))
                .toBe('World Health Organization (2023). COVID-19 Pandemic. World Health Organization.');
        });

        it('names both the container and the publisher of a chapter', () => {
            expect(cite('bookSection', {
                title: 'Economic Action and Social Structure',
                bookTitle: 'The Sociology of Economic Life',
                publisher: 'Westview Press',
                place: 'Boulder, CO',
                pages: '53-81',
                date: '1992',
            }, [{ type: 'author', last: 'Granovetter', first: 'Mark' }]))
                .toBe(
                    'Granovetter, Mark (1992). Economic Action and Social Structure. '
                    + 'The Sociology of Economic Life, Westview Press: Boulder, CO, 53-81.'
                );
        });

        it('places a standard by its body, not its drafting subcommittee', () => {
            const reference = cite('standard', {
                title: 'Information Security',
                organization: 'International Organization for Standardization',
                committee: 'ISO/IEC JTC 1/SC 27',
                number: 'ISO/IEC 27001:2022',
                versionNumber: '3',
                date: '2022',
            });

            expect(reference).toContain('International Organization for Standardization,');
            expect(reference).not.toContain('JTC 1/SC 27');
            expect(reference).toContain('No. ISO/IEC 27001:2022, v3.');
        });
    });

    describe('types with little bibliographic data', () => {
        it('describes an artwork by its medium rather than its type name', () => {
            expect(cite('artwork', { title: 'The Two Fridas', artworkMedium: 'Oil on canvas', date: '1939' }, [
                { type: 'artist', last: 'Kahlo', first: 'Frida' },
            ])).toBe('Kahlo, Frida (1939). The Two Fridas. Oil on canvas.');
        });

        it('reads the medium through its base field, not one type at a time', () => {
            expect(cite('podcast', { title: 'Episode 1', audioFileType: 'MP3', date: '2020' }, [
                { type: 'podcaster', last: 'Vedantam', first: 'Shankar' },
            ])).toBe('Vedantam, Shankar (2020). Episode 1. MP3.');
        });

        it('falls back to the localized type name when nothing else resolves', () => {
            expect(cite('email', { subject: 'Re: Draft manuscript', date: '2024-03-12' }, [
                { type: 'author', last: 'Doe', first: 'Jane' },
            ])).toBe('Doe, Jane (2024). Re: Draft manuscript. E-mail.');
        });

        it('marks an undated item n.d. rather than dropping the year', () => {
            expect(cite('journalArticle', {
                title: 'A Study Without a Date',
                publicationTitle: 'Journal of Missing Metadata',
            }, [{ type: 'author', last: 'Byron', first: 'Ada' }]))
                .toBe('Byron, Ada (n.d.). A Study Without a Date. Journal of Missing Metadata.');
        });

        it('leads with the title when an item has no creators at all', () => {
            expect(cite('journalArticle', { title: 'Nothing But a Title' }))
                .toBe('Nothing But a Title (n.d.). Journal Article.');
        });
    });

    describe('malformed records', () => {
        it('prints a value once when a record stores it in two fields', () => {
            // Translator output sometimes writes the report number into `pages` too.
            expect(cite('report', {
                title: 'The Economic Value of Higher Teacher Quality',
                reportType: 'Working Paper',
                institution: 'National Bureau of Economic Research',
                place: 'Cambridge, MA',
                reportNumber: 'w16606',
                pages: 'w16606',
                date: '2010',
            }, [{ type: 'author', last: 'Hanushek', first: 'Eric A.' }]))
                .toBe(
                    'Hanushek, Eric A. (2010). The Economic Value of Higher Teacher Quality. '
                    + 'Working Paper, National Bureau of Economic Research: Cambridge, MA, No. w16606.'
                );
        });
    });

    it('never emits a URL or DOI', () => {
        const reference = cite('journalArticle', {
            title: 'Attention Is All You Need',
            publicationTitle: 'NeurIPS',
            url: 'https://arxiv.org/abs/1706.03762',
            DOI: '10.48550/arXiv.1706.03762',
            date: '2017',
        }, [{ type: 'author', last: 'Vaswani', first: 'Ashish' }]);

        expect(reference).not.toContain('http');
        expect(reference).not.toContain('10.48550');
    });

    it('survives an item whose fields cannot be read', () => {
        const broken: any = {
            itemType: 'journalArticle',
            itemTypeID: 100,
            getDisplayTitle: () => { throw new Error('not loaded'); },
            getField: () => { throw new Error('Item data not loaded'); },
            getCreators: () => { throw new Error('not loaded'); },
        };

        expect(() => formatItemReference(broken)).not.toThrow();
        expect(formatItemReference(broken)).toBe('(n.d.). Journal Article.');
    });
});
