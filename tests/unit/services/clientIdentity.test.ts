/**
 * Registry contract for the client identity provider used to build WS auth
 * handshakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientIdentity } from '@beaver/agent-core/transport/clientIdentity';

describe('client identity provider registry', () => {
    afterEach(() => {
        vi.resetModules();
    });

    it('throws an actionable error when nothing has been registered', async () => {
        const { resolveClientIdentity } = await import('@beaver/agent-core/transport/clientIdentity');
        expect(() => resolveClientIdentity()).toThrow(/setClientIdentityProvider/);
    });

    it('resolves the identity from the registered provider', async () => {
        const { setClientIdentityProvider, resolveClientIdentity } =
            await import('@beaver/agent-core/transport/clientIdentity');
        const identity: ClientIdentity = {
            frontendVersion: '0.22.0',
            clientType: 'zotero-plugin',
            clientFeatures: ['note_support'],
            zoteroInstance: { local_user_key: 'abc123' },
        };
        setClientIdentityProvider(() => identity);

        expect(resolveClientIdentity()).toBe(identity);
    });

    it('calls the provider fresh on every resolution', async () => {
        const { setClientIdentityProvider, resolveClientIdentity } =
            await import('@beaver/agent-core/transport/clientIdentity');
        const provider = vi.fn<() => ClientIdentity>(() => ({
            frontendVersion: '0.22.0',
            clientType: 'zotero-plugin',
            clientFeatures: [],
        }));
        setClientIdentityProvider(provider);

        resolveClientIdentity();
        resolveClientIdentity();

        expect(provider).toHaveBeenCalledTimes(2);
    });
});
