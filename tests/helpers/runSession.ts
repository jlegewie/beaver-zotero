/**
 * Run-session helpers for unit tests.
 *
 * The chat state a run session owns lives in its private store, and a
 * window's copies of it follow by projection (synchronously in tests, which
 * have no animation frames). Tests set that state up through the session's
 * store, as window code does, and read it from either store.
 */
import { vi } from 'vitest';
import { createStore } from 'jotai';
import type { AgentService } from '@beaver/agent-core/transport/agentService';
import { RunSession, getRunSession, installRunSession } from '../../src/services/agentRuns/runSession';
import { createSessionPort } from '../../src/services/agentRuns/sessionPort';
import type { RunHost } from '../../src/services/agentRuns/runHost';
import { attachRunProjection } from '../../react/runtime/runProjection';
import { sessionStateAtoms } from '../../src/services/agentRuns/sessionState';
import { store as windowStore } from '../../react/store';

type Store = ReturnType<typeof createStore>;

/**
 * A host whose methods are `vi.fn()`s, except those given. `upgradeToolReturn`
 * returns the part it gets, as a host with nothing to upgrade does.
 */
export function fakeRunHost(overrides: Partial<RunHost> = {}): RunHost {
    const methods: Record<string, unknown> = {
        upgradeToolReturn: vi.fn(async (part: unknown) => part),
        ...overrides,
    };
    return new Proxy({} as RunHost, {
        get: (_target, name: string) => (methods[name] ??= vi.fn()),
    });
}

/**
 * The store of the installed run session: where chat state is written. A
 * test that loads no renderer session gets one projected onto the window
 * store, as a renderer's is.
 */
export function chatStore(): Store {
    try {
        return getRunSession().store;
    } catch {
        const session = new RunSession(createStore(), { close: vi.fn() } as unknown as AgentService, fakeRunHost());
        installRunSession(session);
        attachRunProjection(createSessionPort(session), windowStore, sessionStateAtoms(), () => null);
        return getRunSession().store;
    }
}

/**
 * Install a run session whose store is `store` itself, with no projection:
 * for tests that drive the engine or admission on a store of their own.
 */
export function installStoreRunSession(
    store: Store,
    options: { host?: Partial<RunHost>; agentService?: AgentService } = {},
): RunSession {
    const session = new RunSession(
        store,
        options.agentService ?? ({ close: vi.fn() } as unknown as AgentService),
        fakeRunHost(options.host),
    );
    installRunSession(session);
    return session;
}
