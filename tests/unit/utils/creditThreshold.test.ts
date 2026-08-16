import { describe, it, expect } from 'vitest';
import {
    DEFAULT_CREDIT_THRESHOLD,
    MAX_CREDIT_THRESHOLD,
    clampCreditThreshold,
} from '../../../react/utils/creditThreshold';

describe('clampCreditThreshold', () => {
    it('keeps a usable limit as it is', () => {
        expect(clampCreditThreshold(5)).toBe(5);
        expect(clampCreditThreshold(0)).toBe(0);
    });

    it('rounds to the integer the preference can hold', () => {
        expect(clampCreditThreshold(2.5)).toBe(3);
        expect(clampCreditThreshold(2.4)).toBe(2);
    });

    it('caps a value that would wrap the stored integer', () => {
        expect(clampCreditThreshold(3_000_000_000)).toBe(MAX_CREDIT_THRESHOLD);
    });

    it('falls back for a value that cannot be a limit', () => {
        // A build that stored a wrapped value would otherwise send a negative
        // limit on every run, which the server rejects.
        expect(clampCreditThreshold(-1_294_967_296)).toBe(DEFAULT_CREDIT_THRESHOLD);
        expect(clampCreditThreshold(Number.NaN)).toBe(DEFAULT_CREDIT_THRESHOLD);
        expect(clampCreditThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CREDIT_THRESHOLD);
    });
});
