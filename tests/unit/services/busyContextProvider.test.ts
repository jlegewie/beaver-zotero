/**
 * Registry contract for the busy-context provider seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('busy-context provider registry', () => {
    afterEach(() => {
        vi.resetModules();
    });

    it('resolves to an empty snapshot when nothing has been registered', async () => {
        const { resolveBusyContext } = await import('../../../src/services/busyContextProvider');
        expect(resolveBusyContext()).toEqual({});
    });

    it('resolves the snapshot from the registered provider', async () => {
        const { setBusyContextProvider, resolveBusyContext } =
            await import('../../../src/services/busyContextProvider');
        const snapshot = { busy_sync: 1, busy_db_tx: 0 };
        const provider = vi.fn(() => snapshot);

        setBusyContextProvider(provider);
        const resolved = resolveBusyContext();

        expect(resolved).toBe(snapshot);
        expect(provider).toHaveBeenCalledTimes(1);
    });
});
