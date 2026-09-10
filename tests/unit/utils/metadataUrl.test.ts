import { describe, expect, it } from 'vitest';
import { cleanMetadataUrl } from '../../../src/utils/metadataUrl';

describe('metadata URLs', () => {
    it.each(['\u0000\u0000', String.raw`\u0000\u0000`, '', '  ', null])(
        'omits control-only values %j',
        (value) => {
            expect(cleanMetadataUrl(value)).toBeNull();
        },
    );
    it('preserves a valid URL and removes surrounding control characters', () => {
        expect(
            cleanMetadataUrl('\u0000https://example.org/a?q=hello%20world\r\n'),
        ).toBe('https://example.org/a?q=hello%20world');
    });
});
