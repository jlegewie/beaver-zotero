import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    excluded: new Set<number>(),
    eraseTx: vi.fn(async () => {}),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn(() => undefined),
    resolveLibraryRef: vi.fn((ref: any) => ref?.library_id ?? null),
    resolveItemReference: vi.fn(async () => ({ status: 'found', item: { eraseTx: mocks.eraseTx } })),
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn((id: number) => (mocks.excluded.has(id) ? { message: `Library ${id} is excluded` } : null)),
    excludedLibraryUserMessage: vi.fn(() => 'This library is excluded from Beaver.'),
    getAttachmentFileStatus: vi.fn(),
}));
vi.mock('../../../src/services/annotations/createAnnotation', () => ({
    createEpubHighlightAnnotation: vi.fn(),
    createEpubNoteAnnotation: vi.fn(),
    createNoteAnnotation: vi.fn(),
    createPdfHighlightForItem: vi.fn(),
    EpubAnnotationError: class extends Error {},
    HighlightPageSpanError: class extends Error {},
    MissingPageGeometryError: class extends Error {},
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: vi.fn(() => 'pdf'),
}));

import {
    executeCreateHighlightAnnotationsAction,
    executeCreateNoteAnnotationsAction,
    undoCreateAnnotationsAction,
} from '../../../src/services/manualActions/createAnnotationsActions';
import { resolveItemReference } from '../../../src/utils/libraryIdentity';
import { createPdfHighlightForItem, createNoteAnnotation } from '../../../src/services/annotations/createAnnotation';

const ref = { library_id: 2, zotero_key: 'ATTACH01' };
const proposed = { requested_ref: ref, resolved_ref: ref, items: [{ index: 0 }], tags: [] };

describe('manual annotation actions in excluded libraries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.excluded = new Set([2]);
    });

    it.each([
        ['highlight', executeCreateHighlightAnnotationsAction, createPdfHighlightForItem],
        ['note', executeCreateNoteAnnotationsAction, createNoteAnnotation],
    ] as const)('refuses to apply a %s action before looking up the attachment', async (_, execute, create) => {
        await expect(execute({ id: 'a1', proposed_data: proposed } as any)).rejects.toMatchObject({
            message: 'Library 2 is excluded',
            userMessage: 'This library is excluded from Beaver.',
        });
        expect(resolveItemReference).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it('refuses to undo without deleting any created annotation', async () => {
        const created = [{ library_id: 1, zotero_key: 'ANNOT001' }, { library_id: 2, zotero_key: 'ANNOT002' }];

        await expect(undoCreateAnnotationsAction({ id: 'a1', result_data: { created } } as any))
            .rejects.toMatchObject({ userMessage: 'This library is excluded from Beaver.' });
        expect(mocks.eraseTx).not.toHaveBeenCalled();
    });

    it('still undoes annotations in libraries that are not excluded', async () => {
        mocks.excluded.clear();
        await undoCreateAnnotationsAction({ id: 'a1', result_data: { created: [{ library_id: 1, zotero_key: 'ANNOT001' }] } } as any);
        expect(mocks.eraseTx).toHaveBeenCalledOnce();
    });
});
