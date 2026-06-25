import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock heavy transitive deps so we can `importActual` utils.ts.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));

vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/agentDataProvider/utils')>(
        '../../../src/services/agentDataProvider/utils',
    );
    return {
        ...actual,
        resolveToImageAttachment: vi.fn(),
        validateZoteroItemReference: vi.fn(() => null),
        loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
        checkRemotePdfSize: vi.fn(() => null),
        isRemoteAccessAvailable: vi.fn(() => false),
    };
});

vi.mock('../../../src/services/agentDataProvider/imageProcessing', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/agentDataProvider/imageProcessing')>(
        '../../../src/services/agentDataProvider/imageProcessing',
    );
    return {
        ...actual,
        processImageBytes: vi.fn(),
    };
});

import { handleZoteroAttachmentImageRequest } from '../../../src/services/agentDataProvider/handleZoteroAttachmentImageRequest';
import {
    resolveToImageAttachment,
    validateZoteroItemReference,
    loadPdfData,
    checkRemotePdfSize,
    isRemoteAccessAvailable,
} from '../../../src/services/agentDataProvider/utils';
import {
    HARD_MAX_IMAGE_DIMENSION,
    ImageDecodeError,
    UnsupportedImageFormatError,
    processImageBytes,
    type ProcessedImage,
} from '../../../src/services/agentDataProvider/imageProcessing';

function makeProcessedImage(overrides: Partial<ProcessedImage> = {}): ProcessedImage {
    return {
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        format: 'png',
        width: 800,
        height: 600,
        originalWidth: 800,
        originalHeight: 600,
        sourceMime: 'image/png',
        resized: false,
        converted: false,
        ...overrides,
    };
}

function setupZoteroEnv(opts: {
    itemFound?: boolean;
    filePath?: string | false;
    fileSizeBytes?: number;
    isStoredFile?: boolean;
} = {}) {
    const {
        itemFound = true,
        filePath = '/storage/IMG12345/figure.png',
        fileSizeBytes = 1024,
        isStoredFile = true,
    } = opts;

    const resolvedImageItem = {
        id: 42,
        key: 'IMG12345',
        libraryID: 1,
        attachmentContentType: 'image/png',
        getFilePathAsync: vi.fn().mockResolvedValue(filePath),
        isStoredFileAttachment: vi.fn(() => isStoredFile),
        attachmentSyncedHash: null,
    };

    const requestItem = {
        loadAllData: vi.fn().mockResolvedValue(undefined),
    };

    (globalThis as any).Zotero.Items = {
        getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(itemFound ? requestItem : false),
    };
    (globalThis as any).Zotero.Attachments = {
        getTotalFileSize: vi.fn().mockResolvedValue(fileSizeBytes),
    };
    (globalThis as any).Zotero.Beaver = { data: { env: 'test' } };

    vi.mocked(resolveToImageAttachment).mockResolvedValue({
        resolved: true,
        item: resolvedImageItem,
        key: '1-IMG12345',
    } as any);

    return { resolvedImageItem, requestItem };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
        event: 'zotero_attachment_image_request' as const,
        request_id: 'req-1',
        attachment: { library_id: 1, zotero_key: 'PARENT01' },
        ...overrides,
    };
}

describe('handleZoteroAttachmentImageRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(validateZoteroItemReference).mockReturnValue(null as any);
        vi.mocked(isRemoteAccessAvailable).mockReturnValue(false);
        vi.mocked(checkRemotePdfSize).mockReturnValue(null as any);
        vi.mocked(loadPdfData).mockResolvedValue(new Uint8Array([1, 2, 3]));
        vi.mocked(processImageBytes).mockResolvedValue(makeProcessedImage());
    });

    it('returns the processed image with base64 data and resolved_attachment', async () => {
        setupZoteroEnv();
        const processed = makeProcessedImage({
            data: new Uint8Array([0x01, 0x80, 0xff]),
            format: 'jpeg',
            width: 1568,
            height: 1176,
            originalWidth: 4000,
            originalHeight: 3000,
            sourceMime: 'image/jpeg',
            resized: true,
            converted: false,
        });
        vi.mocked(processImageBytes).mockResolvedValue(processed);

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error).toBeUndefined();
        expect(response.resolved_attachment).toEqual({ library_id: 1, zotero_key: 'IMG12345' });
        expect(response.image).toEqual({
            image_data: Buffer.from(processed.data).toString('base64'),
            format: 'jpeg',
            width: 1568,
            height: 1176,
            original_width: 4000,
            original_height: 3000,
            original_format: 'image/jpeg',
            resized: true,
            converted: false,
        });
    });

    it('wires the timeout checker into the processing checkpoint', async () => {
        setupZoteroEnv();
        await handleZoteroAttachmentImageRequest(baseRequest() as any);

        const options = vi.mocked(processImageBytes).mock.calls[0][2];
        expect(typeof options.checkpoint).toBe('function');
        // Within the deadline, the checkpoint must not throw.
        expect(() => options.checkpoint!('test_phase')).not.toThrow();
    });

    it('rejects an invalid item reference', async () => {
        setupZoteroEnv();
        vi.mocked(validateZoteroItemReference).mockReturnValue('library_id must be a number' as any);

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('invalid_format');
        expect(response.image).toBeNull();
    });

    it('rejects an invalid format value', async () => {
        setupZoteroEnv();
        const response = await handleZoteroAttachmentImageRequest(
            baseRequest({ format: 'webp' }) as any,
        );

        expect(response.error_code).toBe('invalid_format');
        expect(response.error).toContain("Invalid format 'webp'");
    });

    it('clamps oversized requested dimensions before processing', async () => {
        setupZoteroEnv();
        await handleZoteroAttachmentImageRequest(
            baseRequest({ max_width: 30000, max_height: 25000 }) as any,
        );

        const options = vi.mocked(processImageBytes).mock.calls[0][2];
        expect(options.maxWidth).toBe(HARD_MAX_IMAGE_DIMENSION);
        expect(options.maxHeight).toBe(HARD_MAX_IMAGE_DIMENSION);
    });

    it('returns not_found when the item does not exist', async () => {
        setupZoteroEnv({ itemFound: false });

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('not_found');
        expect(response.resolved_attachment).toBeNull();
    });

    it('passes resolver errors through with their error codes', async () => {
        setupZoteroEnv();
        vi.mocked(resolveToImageAttachment).mockResolvedValue({
            resolved: false,
            error: 'Attachment 1-PDF00001 is not an image (type: application/pdf)',
            error_code: 'not_image',
        } as any);

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('not_image');
        expect(response.resolved_attachment).toBeNull();
    });

    it('returns file_missing with the resolved attachment when the file is gone', async () => {
        setupZoteroEnv({ filePath: false, isStoredFile: false });

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('file_missing');
        // Post-resolution errors report which child attachment was targeted.
        expect(response.resolved_attachment).toEqual({ library_id: 1, zotero_key: 'IMG12345' });
    });

    it('returns file_too_large for oversized local files', async () => {
        setupZoteroEnv({ fileSizeBytes: 200 * 1024 * 1024 });

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('file_too_large');
        expect(response.error).toContain('200.0MB');
    });

    it('returns download_failed when the remote download throws', async () => {
        setupZoteroEnv({ filePath: false });
        vi.mocked(isRemoteAccessAvailable).mockReturnValue(true);
        vi.mocked(loadPdfData).mockRejectedValue(new Error('storage unreachable'));

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('download_failed');
        expect(response.error).toContain('storage unreachable');
        expect(response.resolved_attachment).toEqual({ library_id: 1, zotero_key: 'IMG12345' });
    });

    it('returns file_too_large when the downloaded remote file is oversized', async () => {
        setupZoteroEnv({ filePath: false });
        vi.mocked(isRemoteAccessAvailable).mockReturnValue(true);
        vi.mocked(checkRemotePdfSize).mockReturnValue({ sizeMB: 150, maxMB: 100 } as any);

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('file_too_large');
        expect(response.error).toContain('150.0MB');
    });

    it('maps UnsupportedImageFormatError to unsupported_image_format', async () => {
        setupZoteroEnv();
        vi.mocked(processImageBytes).mockRejectedValue(new UnsupportedImageFormatError('image/tiff'));

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('unsupported_image_format');
        expect(response.error).toContain("'image/tiff'");
        expect(response.resolved_attachment).toEqual({ library_id: 1, zotero_key: 'IMG12345' });
    });

    it('maps ImageDecodeError to decode_failed', async () => {
        setupZoteroEnv();
        vi.mocked(processImageBytes).mockRejectedValue(new ImageDecodeError('bad bytes'));

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('decode_failed');
        expect(response.error).toContain('bad bytes');
    });

    it('maps unexpected processing errors to image_processing_failed', async () => {
        setupZoteroEnv();
        vi.mocked(processImageBytes).mockRejectedValue(new Error('canvas exploded'));

        const response = await handleZoteroAttachmentImageRequest(baseRequest() as any);

        expect(response.error_code).toBe('image_processing_failed');
        expect(response.error).toContain('canvas exploded');
    });

    it('returns timeout when processing outlives the deadline', async () => {
        setupZoteroEnv();
        vi.mocked(processImageBytes).mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve(makeProcessedImage()), 30)),
        );

        const response = await handleZoteroAttachmentImageRequest(
            baseRequest({ timeout_seconds: 0.001 }) as any,
        );

        expect(response.error_code).toBe('timeout');
        expect(response.error).toContain('timed out after');
    });
});
