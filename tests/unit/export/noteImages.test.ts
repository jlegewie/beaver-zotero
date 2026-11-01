import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { dataUriBytes } from '../../../src/services/export/noteImages';

describe('dataUriBytes', () => {
    it('reads base64 and percent-encoded data URIs, with or without media-type parameters', () => {
        expect(dataUriBytes('data:image/png;base64,AAEC')).toEqual({ mime: 'image/png', data: Uint8Array.from([0, 1, 2]) });
        expect(dataUriBytes('data:image/png;charset=utf-8;base64,AAEC')).toEqual({ mime: 'image/png', data: Uint8Array.from([0, 1, 2]) });
        const svg = dataUriBytes('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
        expect(svg?.mime).toBe('image/svg+xml');
        expect(new TextDecoder().decode(svg!.data)).toBe('<svg/>');
        // Percent escapes are bytes, not UTF-8 text.
        expect(dataUriBytes('data:image/png,%89PNG%0D%0A')?.data).toEqual(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
        expect(dataUriBytes('https://example.com/a.png')).toBeNull();
    });
});
