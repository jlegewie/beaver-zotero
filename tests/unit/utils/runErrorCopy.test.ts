import { describe, expect, it } from 'vitest';

import {
    formatRetryRestorePopupText,
    getRunErrorTitle,
} from '../../../react/utils/runErrorCopy';

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

describe('formatRetryRestorePopupText', () => {
    it('formats typed title plus message', () => {
        expect(formatRetryRestorePopupText({
            type: 'usage_limit_exceeded',
            message: "You've used all your Beaver credits.",
        })).toBe("Limit Reached. You've used all your Beaver credits.");
    });

    it('appends longer connection details after the short message', () => {
        expect(formatRetryRestorePopupText({
            type: 'connection_error',
            message: 'Could not connect to Beaver.',
            details: 'Your device appears to be offline. Reconnect to the internet and try again.',
        })).toBe(
            'Connection Failed. Could not connect to Beaver. Your device appears to be offline. Reconnect to the internet and try again.',
        );
    });

    it('strips a duplicated error-type prefix from the message', () => {
        expect(formatRetryRestorePopupText({
            type: 'internal_error',
            message: 'internal_error: Something went wrong',
        })).toBe('System Error. Something went wrong.');
    });
});
