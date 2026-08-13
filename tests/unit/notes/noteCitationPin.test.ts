/**
 * A locator token must keep resolving against the file it was written against,
 * even after the item's preferred attachment changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(),
    checkLibraryExcluded: vi.fn(() => null),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({ createCitationHTML: vi.fn(() => '<span/>') }));

import {
    preloadStructuralLocatorPages,
    dropStaleResolvedLocators,
} from '../../../src/utils/noteCitationExpand';
import { simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';

const PINNED = 'ATT_PINNED';
const BEST = 'ATT_BEST';

/** One stored citation span on item PARENT01 carrying `loc`, pinned to `att`. */
function citationSpan(loc: string, att?: string): string {
    const data = {
        citationItems: [{
            uris: ['http://zotero.org/users/1/items/PARENT01'],
            locator: '4',
            beaver: { v: 1, loc, ...(att ? { att } : {}) },
        }],
    };
    const encoded = encodeURIComponent(JSON.stringify(data));
    return '<span class="citation" data-citation="' + encoded + '">'
        + '<span class="citation-item">(A, 2024)</span></span>';
}

/** A note wrapping one or more citation spans, each in its own paragraph. */
function noteWith(...spans: string[]): string {
    return '<div data-schema-version="9">'
        + spans.map((span) => '<p>Text ' + span + '</p>').join('')
        + '</div>';
}

/** A stored citation on item PARENT01 carrying `loc` pinned to `att`. */
function pinnedCitationHtml(loc: string, att?: string): string {
    return noteWith(citationSpan(loc, att));
}

/** Extraction whose citation index names the page after its own document. */
function structuredFor(pageLabel: string) {
    return {
        mode: 'structured',
        document: {
            citationIndex: {
                s56: { pageIndex: 0, pageLabel },
                s70: { pageIndex: 0, pageLabel },
            },
        },
    };
}

describe('structural locator resolution honours the stored attachment pin', () => {
    let consulted: string[];

    beforeEach(() => {
        consulted = [];
        const mk = (key: string) => ({
            id: key === PINNED ? 11 : 22,
            key,
            libraryID: 1,
            isAttachment: () => true,
            getFilePathAsync: async () => `/tmp/${key}.pdf`,
        });
        // Regular items resolve to BEST; consulting BEST means no pin was applied.
        const parentNamed = (key: string) => ({
            id: 1, key, libraryID: 1,
            isAttachment: () => false,
            isRegularItem: () => true,
            getAttachments: () => [22],
        });
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn((_lib: number, key: string) =>
                key === PINNED ? mk(PINNED) : parentNamed(key)),
            get: vi.fn(() => mk(BEST)),
            getAsync: vi.fn(async () => [mk(BEST)]),
            loadDataTypes: vi.fn(async () => undefined),
        };
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getResult: vi.fn(async (ref: any) => {
                    consulted.push(ref.zoteroKey);
                    return structuredFor(ref.zoteroKey === PINNED ? 'PIN-PAGE' : 'BEST-PAGE');
                }),
            },
        };
    });

    it('resolves an unchanged token against the pinned attachment, not the current best', async () => {
        const { metadata } = simplifyNoteHtml(pinnedCitationHtml('s56', PINNED), 1);
        const out = await preloadStructuralLocatorPages(
            '<citation id="1-PARENT01" loc="s56"/>', metadata,
        );

        expect(consulted).toEqual([PINNED]);
        expect(Object.values(out.pages)[0]).toEqual({ page: 'PIN-PAGE', attKey: PINNED, pinUsed: PINNED });
    });

    it('falls back to the current best when the note carries no pin', async () => {
        const { metadata } = simplifyNoteHtml(pinnedCitationHtml('s56'), 1);
        const out = await preloadStructuralLocatorPages(
            '<citation id="1-PARENT01" loc="s56"/>', metadata,
        );

        expect(consulted).toEqual([BEST]);
        expect(Object.values(out.pages)[0]).toEqual({ page: 'BEST-PAGE', attKey: BEST });
    });

    it('keeps the pin when the citation\'s locator changes but its item does not', () => {
        // Changing loc within a citation does not retarget the file.
        const { metadata } = simplifyNoteHtml(pinnedCitationHtml('s56', PINNED), 1);
        const ref = [...metadata.elements.keys()][0];
        return preloadStructuralLocatorPages(
            `<citation id="1-PARENT01" loc="s70" ref="${ref}"/>`, metadata,
        ).then((out) => {
            expect(consulted).toEqual([PINNED]);
            expect(Object.values(out.pages)[0]).toEqual({ page: 'PIN-PAGE', attKey: PINNED, pinUsed: PINNED });
        });
    });

    it('drops the pin when the citation is retargeted to a different item', () => {
        // A different item is a real retarget — drop the old pin.
        const { metadata } = simplifyNoteHtml(pinnedCitationHtml('s56', PINNED), 1);
        const ref = [...metadata.elements.keys()][0];
        return preloadStructuralLocatorPages(
            `<citation id="1-OTHERITEM" loc="s56" ref="${ref}"/>`, metadata,
        ).then(() => {
            expect(consulted).toEqual([BEST]);
        });
    });

    it('falls back to the current best when the pinned attachment is gone', async () => {
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn((_l: number, key: string) =>
            key === 'PARENT01'
                ? { id: 1, key: 'PARENT01', libraryID: 1, isAttachment: () => false,
                    isRegularItem: () => true, getAttachments: () => [22] }
                : false);
        const { metadata } = simplifyNoteHtml(pinnedCitationHtml('s56', PINNED), 1);
        const out = await preloadStructuralLocatorPages(
            '<citation id="1-PARENT01" loc="s56"/>', metadata,
        );

        expect(consulted).toEqual([BEST]);
        expect(out.unresolved).toEqual([]);
    });

    it('claims no pin when the same token on one item carries disagreeing pins', () => {
        const { metadata } = simplifyNoteHtml(
            noteWith(citationSpan('s56', PINNED), citationSpan('s56', 'ATT_OTHER')), 1,
        );
        return preloadStructuralLocatorPages('<citation id="1-PARENT01" loc="s56"/>', metadata)
            .then(() => {
                expect(consulted).toEqual([BEST]);
            });
    });
});

/** Same item+locator can be pinned to different files; do not collapse them. */
describe('structural preload results are occurrence-specific', () => {
    let consulted: string[];

    beforeEach(() => {
        consulted = [];
        const attachment = (key: string) => ({
            id: key === PINNED ? 11 : 33,
            key,
            libraryID: 1,
            isAttachment: () => true,
            getFilePathAsync: async () => `/tmp/${key}.pdf`,
        });
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn((_l: number, key: string) =>
                key.startsWith('ATT_')
                    ? attachment(key)
                    : { id: 1, key, libraryID: 1, isAttachment: () => false,
                        isRegularItem: () => true, getAttachments: () => [22] }),
            get: vi.fn(() => attachment(BEST)),
            getAsync: vi.fn(async () => [attachment(BEST)]),
            loadDataTypes: vi.fn(async () => undefined),
        };
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getResult: vi.fn(async (ref: any) => {
                    consulted.push(ref.zoteroKey);
                    return structuredFor(`PAGE-OF-${ref.zoteroKey}`);
                }),
            },
        };
    });

    it('resolves each occurrence against its own pinned document', async () => {
        const { metadata } = simplifyNoteHtml(
            noteWith(citationSpan('s56', PINNED), citationSpan('s56', 'ATT_SECOND')), 1,
        );
        const [refA, refB] = [...metadata.elements.keys()];
        const out = await preloadStructuralLocatorPages(
            `<citation id="1-PARENT01" loc="s56" ref="${refA}"/>`
            + `<citation id="1-PARENT01" loc="s56" ref="${refB}"/>`,
            metadata,
        );

        expect(consulted.sort()).toEqual([PINNED, 'ATT_SECOND'].sort());
        const byKey = Object.entries(out.pages);
        expect(byKey).toHaveLength(2);
        expect(out.pages[`zotero:1-PARENT01:s56#${refA}`])
            .toEqual({ page: `PAGE-OF-${PINNED}`, attKey: PINNED, pinUsed: PINNED });
        expect(out.pages[`zotero:1-PARENT01:s56#${refB}`])
            .toEqual({ page: 'PAGE-OF-ATT_SECOND', attKey: 'ATT_SECOND', pinUsed: 'ATT_SECOND' });
    });
});

/** A resolution made against a pin that moved during the preload must not be written. */
describe('stale pin detection after the preload window', () => {
    it('drops a resolution whose pin moved while the preload was awaiting', () => {
        const before = simplifyNoteHtml(pinnedCitationHtml('s56', PINNED), 1);
        const ref = [...before.metadata.elements.keys()][0];
        const preload = {
            pages: {
                [`zotero:1-PARENT01:s56#${ref}`]: {
                    page: 'PIN-PAGE', attKey: PINNED, pinUsed: PINNED,
                },
            },
            unresolved: [] as string[],
        };

        const after = simplifyNoteHtml(pinnedCitationHtml('s56', 'ATT_MOVED'), 1);
        const checked = dropStaleResolvedLocators(preload, after.metadata);

        expect(checked.pages).toEqual({});
        expect(checked.unresolved).toEqual(['id="1-PARENT01" loc="s56"']);
    });

    it('keeps a resolution whose pin is unchanged', () => {
        const { metadata } = simplifyNoteHtml(pinnedCitationHtml('s56', PINNED), 1);
        const ref = [...metadata.elements.keys()][0];
        const key = `zotero:1-PARENT01:s56#${ref}`;
        const preload = {
            pages: { [key]: { page: 'PIN-PAGE', attKey: PINNED, pinUsed: PINNED } },
            unresolved: [] as string[],
        };

        expect(dropStaleResolvedLocators(preload, metadata).pages).toEqual(preload.pages);
    });

    it('cannot revalidate without metadata, so it keeps what the preload produced', () => {
        const preload = {
            pages: { 'zotero:1-PARENT01:s56': { page: '4', attKey: BEST } },
            unresolved: [] as string[],
        };
        expect(dropStaleResolvedLocators(preload, undefined)).toBe(preload);
    });

    it('drops an UNPINNED resolution when the note gained a pin during the window', () => {
        // A pin that appeared during the await is also stale.
        const after = simplifyNoteHtml(pinnedCitationHtml('s56', PINNED), 1);
        const ref = [...after.metadata.elements.keys()][0];
        const preload = {
            pages: {
                [`zotero:1-PARENT01:s56#${ref}`]: { page: 'BEST-PAGE', attKey: BEST },
            },
            unresolved: [] as string[],
        };

        const checked = dropStaleResolvedLocators(preload, after.metadata);
        expect(checked.pages).toEqual({});
        expect(checked.unresolved).toEqual(['id="1-PARENT01" loc="s56"']);
    });

    it('keeps an unpinned resolution when the note still has no pin for it', () => {
        const { metadata } = simplifyNoteHtml(pinnedCitationHtml('s56'), 1);
        const ref = [...metadata.elements.keys()][0];
        const key = `zotero:1-PARENT01:s56#${ref}`;
        const preload = {
            pages: { [key]: { page: 'BEST-PAGE', attKey: BEST } },
            unresolved: [] as string[],
        };

        expect(dropStaleResolvedLocators(preload, metadata).pages).toEqual(preload.pages);
    });
});
