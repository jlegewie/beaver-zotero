import { describe, expect, it } from 'vitest';

import {
    explicitPageLabel,
    formatLocationChip,
} from '../../../react/utils/locationDisplay';

describe('locationDisplay', () => {
    it('resolves explicit 0-based page labels from 1-based page numbers', () => {
        expect(explicitPageLabel({ 17: '191' }, 18)).toBe('191');
        expect(explicitPageLabel({ 17: '   ' }, 18)).toBe('');
        expect(explicitPageLabel(undefined, 18)).toBe('');
    });

    it('formats PDF page labels with a page prefix', () => {
        expect(formatLocationChip('pdf', 'iv')).toBe('Page iv');
        expect(formatLocationChip('pdf', '')).toBe('');
    });

    it('hides synthetic EPUB section labels but keeps print labels', () => {
        expect(formatLocationChip('epub', 'Section 18')).toBe('');
        expect(formatLocationChip('epub', 'section 18')).toBe('');
        expect(formatLocationChip('epub', '191')).toBe('Page 191');
    });
});
