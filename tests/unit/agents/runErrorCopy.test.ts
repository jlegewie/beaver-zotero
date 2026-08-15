/**
 * Unit tests for `@beaver/agent-core/run-state/runErrorCopy`.
 */

import { describe, expect, it } from 'vitest';

import { getRunErrorTitle, stripRunErrorTypePrefix } from '@beaver/agent-core/run-state/runErrorCopy';

describe('getRunErrorTitle', () => {
    it('maps known error types to the in-chat header titles', () => {
        expect(getRunErrorTitle('usage_limit_exceeded')).toBe('Limit Reached');
        expect(getRunErrorTitle('connection_error')).toBe('Connection Failed');
    });

    it('falls back for unknown types', () => {
        expect(getRunErrorTitle('regeneration_error')).toBe('An error occurred');
        expect(getRunErrorTitle(undefined)).toBe('An error occurred');
    });
});

describe('stripRunErrorTypePrefix', () => {
    it('removes a leading error-type prefix the header already shows', () => {
        expect(stripRunErrorTypePrefix('internal_error: something broke', 'internal_error')).toBe(
            'something broke',
        );
    });

    it('leaves a message without that prefix untouched', () => {
        expect(stripRunErrorTypePrefix('something broke', 'internal_error')).toBe('something broke');
        expect(stripRunErrorTypePrefix('internal_error:no space', 'internal_error')).toBe(
            'internal_error:no space',
        );
        expect(stripRunErrorTypePrefix('other_error: something broke', 'internal_error')).toBe(
            'other_error: something broke',
        );
    });

    it('returns the message unchanged when there is no error type', () => {
        expect(stripRunErrorTypePrefix('internal_error: something broke', undefined)).toBe(
            'internal_error: something broke',
        );
    });
});
