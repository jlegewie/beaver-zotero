import { describe, expect, it } from 'vitest';

import {
    HARD_ATTACHMENT_LIMITS,
    effectiveMaxFileSizeMB,
    effectiveMaxPageCount,
} from '../../../src/services/attachmentLimits';

const { maxFileSizeMB, maxPageCount } = HARD_ATTACHMENT_LIMITS;

describe('attachmentLimits', () => {
    it('exposes positive hard attachment caps', () => {
        expect(maxFileSizeMB).toBeGreaterThan(0);
        expect(maxPageCount).toBeGreaterThan(0);
    });

    it('uses hard caps when no caller-specific limit is provided', () => {
        expect(effectiveMaxFileSizeMB()).toBe(maxFileSizeMB);
        expect(effectiveMaxPageCount()).toBe(maxPageCount);
    });

    it('keeps stricter caller-specific limits', () => {
        expect(effectiveMaxFileSizeMB(25)).toBe(25);
        expect(effectiveMaxPageCount(300)).toBe(300);
    });

    it('clamps caller-specific limits to the hard caps', () => {
        expect(effectiveMaxFileSizeMB(maxFileSizeMB + 150)).toBe(maxFileSizeMB);
        expect(effectiveMaxPageCount(maxPageCount + 2000)).toBe(maxPageCount);
    });

    it('ignores invalid caller-specific limits', () => {
        expect(effectiveMaxFileSizeMB(0)).toBe(maxFileSizeMB);
        expect(effectiveMaxFileSizeMB(Number.NaN)).toBe(maxFileSizeMB);
        expect(effectiveMaxPageCount(-1)).toBe(maxPageCount);
        expect(effectiveMaxPageCount(null)).toBe(maxPageCount);
    });
});
