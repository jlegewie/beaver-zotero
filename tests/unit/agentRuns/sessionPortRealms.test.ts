/**
 * A window reaches a session evaluated in another realm through its port.
 *
 * The plugin realm and a window each evaluate their own copy of the engine
 * modules, so the same atom is a different object in each. Here the two
 * realms are two module graphs: the window projects the session's state,
 * writes it and starts engine actions by name, and never hands the session
 * one of its own atoms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: { auth: {} } }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => undefined }));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { AgentService } from '@beaver/agent-core/transport/agentService';
import { fakeRunHost } from '../../helpers/runSession';

/** One realm's copy of the modules a session and its window use. */
async function loadRealm() {
    return {
        jotai: await import('jotai/vanilla'),
        atoms: await import('@beaver/agent-core/run-state/atoms'),
        runSession: await import('../../../src/services/agentRuns/runSession'),
        sessionPort: await import('../../../src/services/agentRuns/sessionPort'),
        sessionState: await import('../../../src/services/agentRuns/sessionState'),
        engine: await import('../../../src/services/agentRuns/runEngine'),
        projection: await import('../../../react/runtime/runProjection'),
        sessionStore: await import('../../../react/runtime/runSessionStore'),
    };
}

function run(id: string, status: AgentRun['status']): AgentRun {
    return {
        id,
        thread_id: 'thread-1',
        status,
        model_messages: [],
        user_prompt: { content: 'question', is_resume: false },
    } as unknown as AgentRun;
}

describe('a session in another realm', () => {
    let plugin: Awaited<ReturnType<typeof loadRealm>>;
    let win: Awaited<ReturnType<typeof loadRealm>>;
    let session: InstanceType<typeof plugin.runSession.RunSession>;
    let view: ReturnType<typeof win.jotai.createStore>;
    let detach: () => void;

    beforeEach(async () => {
        vi.resetModules();
        plugin = await loadRealm();
        vi.resetModules();
        win = await loadRealm();
        session = new plugin.runSession.RunSession(
            plugin.jotai.createStore(),
            { close: vi.fn() } as unknown as AgentService,
            fakeRunHost(),
        );
        win.runSession.installSessionPort(plugin.sessionPort.createSessionPort(session));
        view = win.jotai.createStore();
        detach = win.projection.attachRunProjection(
            win.runSession.getSessionPort(),
            view,
            win.sessionState.sessionStateAtoms(),
            () => null,
        ).detach;
    });

    afterEach(() => detach());

    it('evaluates separate atoms in each realm', () => {
        expect(win.atoms.activeRunAtom).not.toBe(plugin.atoms.activeRunAtom);
        expect(win.engine.closeWSConnectionAtom).not.toBe(plugin.engine.closeWSConnectionAtom);
    });

    it('projects session state onto the window by name, sharing the values', () => {
        const active = run('run-1', 'in_progress');
        session.store.set(plugin.atoms.activeRunAtom, active);
        session.store.set(plugin.atoms.currentThreadIdAtom, 'thread-1');

        expect(view.get(win.atoms.activeRunAtom)).toBe(active);
        expect(view.get(win.atoms.currentThreadIdAtom)).toBe('thread-1');
    });

    it('writes the window\'s changes to the session, not to its own copies', () => {
        const chat = win.sessionStore.runSessionStore();
        chat.set(win.atoms.currentThreadNameAtom, 'Renamed');
        chat.set(win.atoms.threadRunsAtom, (previous: AgentRun[]) => [...previous, run('run-0', 'completed')]);

        expect(session.store.get(plugin.atoms.currentThreadNameAtom)).toBe('Renamed');
        expect(session.store.get(plugin.atoms.threadRunsAtom).map((entry: AgentRun) => entry.id)).toEqual(['run-0']);
        expect(view.get(win.atoms.currentThreadNameAtom)).toBe('Renamed');
    });

    it('runs an engine action the window starts in the session\'s realm', () => {
        session.store.set(plugin.engine.isWSChatPendingAtom, true);

        // The window sets its own copy of the action on its own store.
        view.set(win.engine.resetWSStateAtom);

        expect(session.store.get(plugin.engine.isWSChatPendingAtom)).toBe(false);
        expect(view.get(win.engine.isWSChatPendingAtom)).toBe(false);
    });

    it('refuses an atom that is not session state', () => {
        const stray = win.jotai.atom(0);
        expect(() => win.sessionStore.runSessionStore().set(stray, 1)).toThrow(/Not a session atom/);
    });

    it('stops applying the session\'s state once detached', () => {
        detach();
        session.store.set(plugin.atoms.currentThreadIdAtom, 'thread-2');
        expect(view.get(win.atoms.currentThreadIdAtom)).toBeNull();
        detach = () => {};
    });
});
