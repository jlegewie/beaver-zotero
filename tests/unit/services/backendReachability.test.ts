import { afterEach, describe, expect, it } from 'vitest';
import {
    clearBackendHttpSuccess,
    getLastBackendHttpSuccess,
    normalizeEndpointForTelemetry,
    recordBackendHttpSuccess,
} from '../../../src/services/backendReachability';

describe('normalizeEndpointForTelemetry', () => {
    it('keeps static route segments unchanged', () => {
        expect(normalizeEndpointForTelemetry('/api/v1/account/profile')).toBe(
            '/api/v1/account/profile',
        );
    });

    it('redacts UUID path segments', () => {
        expect(
            normalizeEndpointForTelemetry(
                '/api/v1/agents/beaver/threads/0d9f0a3c-1b2e-4d5f-8a7b-6c5d4e3f2a1b/runs',
            ),
        ).toBe('/api/v1/agents/beaver/threads/:id/runs');
    });

    it('redacts numeric and item-key segments', () => {
        expect(
            normalizeEndpointForTelemetry('/api/v1/attachments/status/12345/ZRKSCH67'),
        ).toBe('/api/v1/attachments/status/:id/:id');
    });

    it('strips query strings entirely', () => {
        expect(
            normalizeEndpointForTelemetry('/api/v1/agents/beaver/runs?limit=20&after=abc'),
        ).toBe('/api/v1/agents/beaver/runs');
    });
});

describe('recordBackendHttpSuccess', () => {
    afterEach(() => {
        clearBackendHttpSuccess();
    });

    it('normalizes path-shaped sources at the recording choke point', () => {
        recordBackendHttpSuccess(
            '/api/v1/agents/beaver/runs/0d9f0a3c-1b2e-4d5f-8a7b-6c5d4e3f2a1b?include_actions=true',
        );
        expect(getLastBackendHttpSuccess()?.source).toBe(
            '/api/v1/agents/beaver/runs/:id',
        );
    });

    it('passes non-path sources through unchanged', () => {
        recordBackendHttpSuccess('connection_diagnostic');
        expect(getLastBackendHttpSuccess()?.source).toBe('connection_diagnostic');
    });
});
