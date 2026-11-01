/**
 * `activateStoredCitation`: a table document's citation is handed to the
 * chat's citation activation only when that does better than the document's
 * own link.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '@beaver/agent-core/types/citations';

const { resolveItemReference, notifyReferenceUnavailable, cleanupAll } = vi.hoisted(() => ({
    resolveItemReference: vi.fn(),
    notifyReferenceUnavailable: vi.fn(),
    cleanupAll: vi.fn(),
}));

vi.mock('../../../react/store', () => ({ store: { get: vi.fn(() => ({})), set: vi.fn() } }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn(() => false) }));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll, addToTracking: vi.fn() },
    createBoundingBoxHighlights: vi.fn(),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference,
    libraryRefForLibraryID: vi.fn(),
}));
vi.mock('../../../react/host/zotero/sourceActions', () => ({
    launchExternalFile: vi.fn(),
    notifyReferenceUnavailable,
}));

import { activateStoredCitation } from '../../../react/host/zotero/citationActivation';

const pdf = { kind: 'zotero' as const, library_id: 1, library_ref: 'u', zotero_key: 'ATTACH01' };
const doc = {} as Document;

describe('activateStoredCitation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveItemReference.mockResolvedValue({ status: 'missing' });
    });

    it('navigates a PDF citation that names its passage', async () => {
        const citation: Citation = {
            citation_id: 'c',
            resolved_ref: pdf,
            citation_type: 'attachment',
            content_kind: 'pdf',
            locations: [{ part_id: 's1', page_idx: 1, boxes: [[1, 2, 3, 4]] }],
        };
        expect(await activateStoredCitation(citation, doc)).toBe(true);
        expect(resolveItemReference).toHaveBeenCalledWith(
            expect.objectContaining({ zotero_key: 'ATTACH01', library_ref: 'u' }),
        );
    });

    it('leaves a PDF cited without a page or passage to the link, which opens the file', async () => {
        const citation: Citation = {
            citation_id: 'c',
            resolved_ref: pdf,
            citation_type: 'attachment',
            content_kind: 'pdf',
        };
        expect(await activateStoredCitation(citation, doc)).toBe(false);
        expect(resolveItemReference).not.toHaveBeenCalled();
    });

    it('leaves invalid citations and unmapped external works to the link', async () => {
        expect(await activateStoredCitation({ citation_id: 'c', resolved_ref: pdf, invalid: true }, doc)).toBe(false);
        expect(
            await activateStoredCitation(
                { citation_id: 'c', resolved_ref: { kind: 'external', external_id: 'W1' } },
                doc,
            ),
        ).toBe(false);
        expect(resolveItemReference).not.toHaveBeenCalled();
    });
});
