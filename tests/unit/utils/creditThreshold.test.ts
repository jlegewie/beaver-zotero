import { describe, it, expect } from 'vitest';
import {
    DEFAULT_CREDIT_THRESHOLD,
    MAX_CREDIT_THRESHOLD,
    clampCreditThreshold,
    parseCreditLimitEntry,
    MIN_CREDIT_THRESHOLD,
} from '@beaver/agent-ui/utils/creditThreshold';

describe('clampCreditThreshold', () => {
    it('keeps a usable limit as it is', () => {
        expect(clampCreditThreshold(5)).toBe(5);
        expect(clampCreditThreshold(MIN_CREDIT_THRESHOLD)).toBe(MIN_CREDIT_THRESHOLD);
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
        expect(clampCreditThreshold(0)).toBe(DEFAULT_CREDIT_THRESHOLD);
        expect(clampCreditThreshold(Number.NaN)).toBe(DEFAULT_CREDIT_THRESHOLD);
        expect(clampCreditThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CREDIT_THRESHOLD);
    });
});

describe('parseCreditLimitEntry', () => {
    it('reads a number as the limit', () => {
        expect(parseCreditLimitEntry('12')).toEqual({ kind: 'limit', value: 12 });
        expect(parseCreditLimitEntry('  8 ')).toEqual({ kind: 'limit', value: 8 });
    });

    it('reads an empty field as never asking', () => {
        // Clearing the field is the only way to say "never", so it must not be
        // treated as a typo and reverted.
        expect(parseCreditLimitEntry('')).toEqual({ kind: 'never' });
        expect(parseCreditLimitEntry('   ')).toEqual({ kind: 'never' });
    });

    it('bounds a limit the preference cannot hold', () => {
        expect(parseCreditLimitEntry('3000000000')).toEqual({
            kind: 'limit',
            value: MAX_CREDIT_THRESHOLD,
        });
    });

    it('rejects anything that is not a usable limit', () => {
        expect(parseCreditLimitEntry('-3')).toEqual({ kind: 'invalid' });
        expect(parseCreditLimitEntry('abc')).toEqual({ kind: 'invalid' });
    });

    it('refuses a limit below the minimum rather than rounding it up', () => {
        // Clearing the field is how the user says "never ask"; a limit under
        // the minimum is a typo, and silently storing 1 would hide that.
        expect(parseCreditLimitEntry('0')).toEqual({ kind: 'invalid' });
        expect(parseCreditLimitEntry('0.4')).toEqual({ kind: 'invalid' });
        expect(parseCreditLimitEntry(String(MIN_CREDIT_THRESHOLD))).toEqual({
            kind: 'limit',
            value: MIN_CREDIT_THRESHOLD,
        });
    });
});
