import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import {
    getBytesFromSignedUrl,
    putBytesToSignedUrl,
    SignedUrlTransferError,
} from '../../../src/services/ocr/gcsTransfer';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('putBytesToSignedUrl', () => {
    it('PUTs the bytes with the given content type', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });

        await putBytesToSignedUrl('https://gcs/put', new Uint8Array([1, 2, 3]), {
            contentType: 'application/pdf',
            retries: 0,
        });

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://gcs/put');
        expect(init.method).toBe('PUT');
        expect(init.headers['Content-Type']).toBe('application/pdf');
    });

    it('throws a SignedUrlTransferError on a non-ok response', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });

        await expect(
            putBytesToSignedUrl('https://gcs/put', new Uint8Array([1]), { retries: 0 }),
        ).rejects.toBeInstanceOf(SignedUrlTransferError);
    });

    it('aborts immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            putBytesToSignedUrl('https://gcs/put', new Uint8Array([1]), {
                signal: controller.signal,
            }),
        ).rejects.toThrow('aborted');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('getBytesFromSignedUrl', () => {
    it('returns the downloaded bytes', async () => {
        const payload = new Uint8Array([7, 8, 9]);
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            arrayBuffer: async () => payload.buffer,
        });

        const bytes = await getBytesFromSignedUrl('https://gcs/get', { retries: 0 });

        expect(Array.from(bytes)).toEqual([7, 8, 9]);
        expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    });

    it('throws on a non-ok download', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

        await expect(
            getBytesFromSignedUrl('https://gcs/get', { retries: 0 }),
        ).rejects.toBeInstanceOf(SignedUrlTransferError);
    });
});
