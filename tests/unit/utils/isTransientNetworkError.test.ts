import { describe, expect, it } from 'vitest';
import { ApiError, ServerError, SessionRefreshError } from '../../../react/types/apiErrors';
import { isTransientNetworkError } from '../../../react/utils/isTransientNetworkError';

describe('isTransientNetworkError', () => {
    it('treats coded JSON 5xx and rate-limit responses as transient', () => {
        expect(isTransientNetworkError(
            new ApiError(503, 'Unavailable', 'retry', 'index_write_failed'),
        )).toBe(true);
        expect(isTransientNetworkError(
            new ApiError(429, 'Rate Limited', 'retry'),
        )).toBe(true);
    });

    it('keeps ordinary API and programming errors terminal', () => {
        expect(isTransientNetworkError(new ApiError(400, 'Bad Request'))).toBe(false);
        expect(isTransientNetworkError(new TypeError('bug'))).toBe(false);
        expect(isTransientNetworkError(new ServerError())).toBe(true);
        expect(isTransientNetworkError(new SessionRefreshError())).toBe(true);
    });
});
