/**
 * Registry contract for the default agent data-provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    unknownDataRequestErrorResponse,
    type AgentDataProviderMap,
} from '@beaver/agent-core/transport/agentDataDispatch';

describe('unknownDataRequestErrorResponse', () => {
    it('builds a typed error reply for an unmatched *_request event', () => {
        expect(unknownDataRequestErrorResponse({
            event: 'resolve_population_request',
            request_id: 'req-1',
        })).toEqual({
            type: 'resolve_population',
            request_id: 'req-1',
            error: 'Unknown event type: resolve_population_request. Do not try this operation again.',
            error_code: 'internal_error',
        });
    });

    it('returns null when the event is not a request/response exchange', () => {
        expect(unknownDataRequestErrorResponse({
            event: 'batch_approval_stale',
            request_id: 'req-1',
        })).toBeNull();
        expect(unknownDataRequestErrorResponse({
            event: 'resolve_population_request',
        })).toBeNull();
        expect(unknownDataRequestErrorResponse({
            event: 'resolve_population_request',
            request_id: '',
        })).toBeNull();
    });
});


describe('default agent data-provider registry', () => {
    afterEach(() => {
        vi.resetModules();
    });

    it('throws an actionable error when nothing has been registered', async () => {
        const { resolveDefaultAgentDataProvider } = await import('@beaver/agent-core/transport/agentDataDispatch');
        expect(() => resolveDefaultAgentDataProvider()).toThrow(/setDefaultAgentDataProvider/);
    });

    it('resolves the map from the registered factory', async () => {
        const { setDefaultAgentDataProvider, resolveDefaultAgentDataProvider } =
            await import('@beaver/agent-core/transport/agentDataDispatch');
        const fakeMap: AgentDataProviderMap = {};
        const factory = vi.fn(() => fakeMap);

        setDefaultAgentDataProvider(factory);
        const resolved = resolveDefaultAgentDataProvider();

        expect(resolved).toBe(fakeMap);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('forwards options to the registered factory', async () => {
        const { setDefaultAgentDataProvider, resolveDefaultAgentDataProvider } =
            await import('@beaver/agent-core/transport/agentDataDispatch');
        const factory = vi.fn(() => ({} as AgentDataProviderMap));

        setDefaultAgentDataProvider(factory);
        resolveDefaultAgentDataProvider({ syncPauseOwner: 'provider-mutating-run' });

        expect(factory).toHaveBeenCalledWith({ syncPauseOwner: 'provider-mutating-run' });
    });
});

describe('sync-pause resume seam', () => {
    afterEach(() => {
        vi.resetModules();
    });

    it('is a no-op when nothing has been registered', async () => {
        const { notifySyncPauseOwnerSettled } = await import('@beaver/agent-core/transport/agentDataDispatch');
        expect(() => notifySyncPauseOwnerSettled('local-mutating-run')).not.toThrow();
    });

    it('forwards the settled owner to the registered handler', async () => {
        const { setSyncPauseResumeHandler, notifySyncPauseOwnerSettled } =
            await import('@beaver/agent-core/transport/agentDataDispatch');
        const handler = vi.fn();

        setSyncPauseResumeHandler(handler);
        notifySyncPauseOwnerSettled('provider-mutating-run');

        expect(handler).toHaveBeenCalledWith('provider-mutating-run');
    });
});
