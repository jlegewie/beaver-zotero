import { beforeEach, describe, expect, it, vi } from 'vitest';

import { extractTextDocument, TEXT_SCHEMA_VERSION } from '../../../src/services/documentExtraction';
import { createMockAttachment } from '../../helpers/factories';

function textAttachment(overrides: { path?: string | null; contentType?: string } = {}) {
    const attachment = createMockAttachment({
        key: 'TEXT0001',
        contentType: overrides.contentType ?? 'text/plain',
        filename: 'notes.txt',
    }) as any;
    attachment.getFilePathAsync = vi.fn(async () =>
        Object.prototype.hasOwnProperty.call(overrides, 'path')
            ? overrides.path
            : '/mock/notes.txt',
    );
    attachment.isStoredFileAttachment = vi.fn(() => false);
    return attachment as Zotero.Item;
}

function bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

describe('extractTextDocument', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(IOUtils.stat).mockResolvedValue({ lastModified: 100, size: 10 } as any);
        vi.mocked(IOUtils.read).mockResolvedValue(bytes(''));
        vi.mocked(Zotero.Prefs.get).mockImplementation((key: string) =>
            key === 'extensions.zotero.__addonRef__.accessRemoteFiles' ? false : undefined,
        );
    });

    it('decodes UTF-8, strips BOM, normalizes newlines, and counts lines', async () => {
        vi.mocked(IOUtils.read).mockResolvedValue(bytes('\uFEFFalpha\r\nbravo\rcafé'));

        const result = await extractTextDocument({
            item: textAttachment({ contentType: 'text/markdown' }),
            requestKey: '1-TEXT0001',
            contentType: 'text/markdown',
            maxFileSizeMB: 1,
        });

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(result.result).toEqual({
            content_kind: 'text',
            schemaVersion: TEXT_SCHEMA_VERSION,
            sourceContentType: 'text/markdown',
            lineCount: 3,
            text: 'alpha\nbravo\ncafé',
        });
        expect(result.contentType).toBe('text/markdown');
        expect(result.resolvedAttachment).toEqual({ libraryId: 1, zoteroKey: 'TEXT0001' });
    });

    it('treats an empty file as a valid zero-line text document', async () => {
        vi.mocked(IOUtils.read).mockResolvedValue(bytes(''));

        const result = await extractTextDocument({
            item: textAttachment(),
            requestKey: '1-TEXT0001',
            contentType: 'text/plain',
            maxFileSizeMB: 1,
        });

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(result.result.text).toBe('');
        expect(result.result.lineCount).toBe(0);
    });

    it('returns file_too_large when local stat exceeds the limit', async () => {
        vi.mocked(IOUtils.stat).mockResolvedValue({ lastModified: 100, size: 2 * 1024 * 1024 } as any);

        const result = await extractTextDocument({
            item: textAttachment(),
            requestKey: '1-TEXT0001',
            contentType: 'text/plain',
            maxFileSizeMB: 1,
        });

        expect(result).toMatchObject({
            kind: 'response_error',
            code: 'file_too_large',
        });
        expect(IOUtils.read).not.toHaveBeenCalled();
    });

    it('returns file_missing when no local or remote path is available', async () => {
        const result = await extractTextDocument({
            item: textAttachment({ path: null }),
            requestKey: '1-TEXT0001',
            contentType: 'text/plain',
            maxFileSizeMB: 1,
        });

        expect(result).toMatchObject({
            kind: 'response_error',
            code: 'file_missing',
        });
    });
});
