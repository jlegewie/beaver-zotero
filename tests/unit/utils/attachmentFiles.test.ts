import { describe, expect, it } from 'vitest';

import { safeAttachmentFilename } from '../../../src/utils/attachmentFiles';

/**
 * Build an attachment whose `attachmentFilename` getter throws, the way
 * Zotero's does when `PathUtils.filename()` cannot parse the stored path.
 */
function makeUnparseableAttachment(attachmentPath: string | undefined): Zotero.Item {
    return {
        get attachmentFilename(): string {
            throw new Error(
                'OperationError: PathUtils.filename: Could not initialize path: '
                + 'NS_ERROR_FILE_UNRECOGNIZED_PATH'
            );
        },
        attachmentPath,
    } as unknown as Zotero.Item;
}

describe('safeAttachmentFilename', () => {
    it('returns the filename for a healthy attachment', () => {
        const item = { attachmentFilename: 'paper.pdf' } as unknown as Zotero.Item;
        expect(safeAttachmentFilename(item)).toBe('paper.pdf');
    });

    it('normalizes an empty filename to null', () => {
        const item = { attachmentFilename: '' } as unknown as Zotero.Item;
        expect(safeAttachmentFilename(item)).toBeNull();
    });

    it('falls back to the basename of a Windows path the getter cannot parse', () => {
        const item = makeUnparseableAttachment('C:\\Users\\x\\Zotero\\storage\\paper.pdf');
        expect(safeAttachmentFilename(item)).toBe('paper.pdf');
    });

    it('falls back to the basename of a POSIX path the getter cannot parse', () => {
        const item = makeUnparseableAttachment('~/Documents/library/paper.pdf');
        expect(safeAttachmentFilename(item)).toBe('paper.pdf');
    });

    it('returns null when the getter throws and there is no usable path', () => {
        expect(safeAttachmentFilename(makeUnparseableAttachment(undefined))).toBeNull();
        expect(safeAttachmentFilename(makeUnparseableAttachment(''))).toBeNull();
    });

    it('returns null when reading the path throws too', () => {
        const item = {
            get attachmentFilename(): string {
                throw new Error('NS_ERROR_FILE_UNRECOGNIZED_PATH');
            },
            get attachmentPath(): string {
                throw new Error('unavailable');
            },
        } as unknown as Zotero.Item;
        expect(safeAttachmentFilename(item)).toBeNull();
    });
});
