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
