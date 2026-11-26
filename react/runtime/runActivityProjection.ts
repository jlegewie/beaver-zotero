import { RUN_ACTIVITY_EVENT, type RunActivity } from '../../src/services/agentRuns/runActivity';
import type { WindowRuntime } from '../../src/runtime/instance';
import { runActivityAtom } from '../atoms/runActivity';
import { store } from '../store';

/**
 * Follow the instance's chats with a run going in this window's store:
 * hydrate from the registry, then apply each change it publishes. The
 * subscription ends with the window.
 */
export function attachRunActivityProjection(runtime: WindowRuntime): void {
    const registry = Zotero.Beaver?.agentRuns;
    if (!registry) return;
    Zotero.Beaver.runtime.subscribeWindow(runtime, RUN_ACTIVITY_EVENT, (activity: RunActivity[]) => {
        store.set(runActivityAtom, Array.isArray(activity) ? activity : []);
    });
    // Copied: the registry's entries are the plugin realm's.
    store.set(runActivityAtom, JSON.parse(JSON.stringify(registry.listActivity())));
}
