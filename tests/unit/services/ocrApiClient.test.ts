import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/supabaseClient', () => ({ supabase: {} }));
vi.mock('../../../src/utils/getAPIBaseURL', () => ({ default: 'https://api.test' }));

import { OcrApiClient } from '../../../src/services/ocr/ocrApiClient';

describe('OcrApiClient.statusBatch', () => {
    it('builds a repeated job_ids query string', async () => {
        const client = new OcrApiClient('https://api.test');
        const get = vi
            .spyOn(client as any, 'get')
            .mockResolvedValue({ jobs: [] });

        await client.statusBatch(['a1', 'b2', 'c3']);

        expect(get).toHaveBeenCalledOnce();
        expect(get.mock.calls[0][0]).toBe(
            '/api/v1/ocr/status/batch?job_ids=a1&job_ids=b2&job_ids=c3',
        );
    });

    it('percent-encodes each job id', async () => {
        const client = new OcrApiClient('https://api.test');
        const get = vi
            .spyOn(client as any, 'get')
            .mockResolvedValue({ jobs: [] });

        await client.statusBatch(['a/b', 'c&d']);

        expect(get.mock.calls[0][0]).toBe(
            '/api/v1/ocr/status/batch?job_ids=a%2Fb&job_ids=c%26d',
        );
    });
});

describe('OcrApiClient.reportOutcome', () => {
    it('POSTs the outcome to /ocr/outcome', async () => {
        const client = new OcrApiClient('https://api.test');
        const post = vi
            .spyOn(client as any, 'post')
            .mockResolvedValue({ success: true });

        const report = {
            file_hash: 'hash123',
            outcome_code: 'ocr_geometry_mismatch',
            engine_version: 'ocrmypdf-1',
            page_count: 12,
            detail: 'page 0 width',
        };
        await client.reportOutcome(report);

        expect(post).toHaveBeenCalledOnce();
        expect(post.mock.calls[0][0]).toBe('/api/v1/ocr/outcome');
        expect(post.mock.calls[0][1]).toEqual(report);
    });
});
