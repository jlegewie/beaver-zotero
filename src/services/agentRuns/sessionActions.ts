/**
 * The engine's action atoms, by name.
 *
 * A window and the plugin realm each evaluate their own copy of the engine
 * modules, so the same action is a different atom object in each. A window
 * names an action to have its session run it (`SessionPort.set`); each realm
 * finds its own atom under that name here.
 *
 * Kept free of imports: the engine registers its actions while its modules
 * are still loading.
 */

import type { WritableAtom } from 'jotai/vanilla';

type SessionWriteAtom = WritableAtom<unknown, any[], unknown>;

const actions = new Map<string, SessionWriteAtom>();

export function registerSessionAction(name: string, action: SessionWriteAtom): void {
    if (actions.has(name)) throw new Error(`Session action "${name}" is defined twice`);
    actions.set(name, action);
}

export function registeredSessionActions(): ReadonlyMap<string, SessionWriteAtom> {
    return actions;
}
