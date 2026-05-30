import { describe, expect, it } from 'vitest';

import {
    HARD_ATTACHMENT_LIMITS,
    effectiveMaxFileSizeMB,
    effectiveMaxPageCount,
} from '../../../src/services/attachmentLimits';

describe('attachmentLimits', () => {
    it('exposes the Beaver hard attachment caps', () => {
        expect(HARD_ATTACHMENT_LIMITS).toEqual({
            maxFileSizeMB: 100,
            maxPageCount: 800,
        });
    });

    it('uses hard caps when no caller-specific limit is provided', () => {
        expect(effectiveMaxFileSizeMB()).toBe(100);
        expect(effectiveMaxPageCount()).toBe(800);
    });

    it('keeps stricter caller-specific limits', () => {
        expect(effectiveMaxFileSizeMB(25)).toBe(25);
        expect(effectiveMaxPageCount(300)).toBe(300);
    });

    it('clamps caller-specific limits to the hard caps', () => {
        expect(effectiveMaxFileSizeMB(250)).toBe(100);
        expect(effectiveMaxPageCount(5000)).toBe(800);
    });

    it('ignores invalid caller-specific limits', () => {
        expect(effectiveMaxFileSizeMB(0)).toBe(100);
        expect(effectiveMaxFileSizeMB(Number.NaN)).toBe(100);
        expect(effectiveMaxPageCount(-1)).toBe(800);
        expect(effectiveMaxPageCount(null)).toBe(800);
    });
});

