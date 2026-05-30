/**
 * Thin wrapper around Mozilla's `nsIUserIdleService` so the rest of the
 * plugin can read OS-level idle time and subscribe to idle transitions
 * without touching `Components.classes` directly. Lives on the esbuild
 * side; do not import from the webpack React bundle.
 */

/**
 * Milliseconds since the user last touched mouse/keyboard anywhere on the OS.
 * Returns 0 when the idle service cannot be obtained — treat that as active use
 * so the background loop stays conservative.
 */
export function getSystemIdleTimeMs(): number {
    try {
        const svc = (Components.classes as any)[
            '@mozilla.org/widget/useridleservice;1'
        ].getService(
            (Components.interfaces as any).nsIUserIdleService,
        );
        return svc.idleTime;
    } catch {
        // Treat an unavailable idle service as active use.
        return 0;
    }
}

export interface IdleObserver { onIdle(): void; }

/**
 * Subscribe to the system idle service. Fires `onIdle()` each time the user
 * has been idle for at least `thresholdSec` seconds. The `'active'` topic is
 * intentionally ignored — the background loop re-checks idle time at the next
 * claim instead of interrupting in-flight work. Returns a disposer.
 */
export function registerIdleObserver(obs: IdleObserver, thresholdSec: number): () => void {
    const svc = (Components.classes as any)[
        '@mozilla.org/widget/useridleservice;1'
    ].getService(
        (Components.interfaces as any).nsIUserIdleService,
    );
    const xpcomObs = {
        observe(_subject: unknown, topic: string) {
            if (topic === 'idle') obs.onIdle();
        },
    };
    svc.addIdleObserver(xpcomObs, thresholdSec);
    return () => {
        try {
            svc.removeIdleObserver(xpcomObs, thresholdSec);
        } catch {
            // best-effort
        }
    };
}
