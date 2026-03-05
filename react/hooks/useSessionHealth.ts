/**
 * useSessionHealth — proactive session health management
 *
 * Two defense layers against automatic logout after inactivity:
 *
 * Layer 1: Gecko idle-observer (nsIUserIdleService)
 *   When the user returns after ≥60 s of idle/sleep, proactively refresh the
 *   Supabase session. This catches the most common scenario: laptop sleep →
 *   wake → Gecko's throttled setInterval fires a stale auto-refresh that fails.
 *
 * Layer 2: Sidebar-visibility check
 *   When the sidebar transitions hidden → visible, check whether the access
 *   token is expired (or within 5 min of expiry) and refresh if so.
 *
 * Both layers are rate-limited to 1 refresh per 30 s and never trigger
 * sign-out on failure — that responsibility stays with the Supabase SDK.
 *
 * Multi-window safety: The idle observer and rate-limit state live on the
 * Zotero global (shared across all windows), so only one observer is ever
 * registered regardless of how many main windows are open.
 */
import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { supabase, lastAutoRefreshSuccessMs } from '../../src/services/supabaseClient';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { sessionAtom } from '../atoms/auth';
import { store } from '../store';
import { logger } from '../../src/utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RATE_LIMIT_MS = 30_000; // min interval between proactive refreshes
const IDLE_TIMEOUT_S = 60; // seconds of idle before observer fires
const EXPIRY_BUFFER_MS = 5 * 60_000; // 5 min — refresh if token expires within this window
const WAKE_DELAY_MS = 3_000; // wait for network after wake

// ---------------------------------------------------------------------------
// Module-load cleanup: tear down stale state from a previous bundle (plugin
// reload). The old observer's closure captures the old proactiveSessionRefresh
// (and thus the old supabase client), so we must unregister it and start fresh.
// Mirrors the __beaverDisposeSupabase pattern in supabaseClient.ts.
// ---------------------------------------------------------------------------
if (Zotero.__beaverSessionHealth) {
    const prev = Zotero.__beaverSessionHealth;
    if (prev.idleObserverRegistered) {
        try {
            const idleService = Cc['@mozilla.org/widget/useridleservice;1']
                .getService(Ci.nsIUserIdleService);
            idleService.removeIdleObserver(prev.idleObserver, IDLE_TIMEOUT_S);
            logger('useSessionHealth: Cleaned up stale idle observer from previous bundle');
        } catch (err) {
            logger(`useSessionHealth: Failed to clean up stale idle observer: ${err}`, 2);
        }
    }
    Zotero.__beaverSessionHealth = undefined;
}

// ---------------------------------------------------------------------------
// Cross-window singleton state on Zotero global
//
// Because the webpack bundle is loaded once per main window, module-level
// variables are per-window. To ensure only one idle observer is registered
// across all windows, we store shared state on the Zotero global object.
// ---------------------------------------------------------------------------
interface SessionHealthState {
    refCount: number;
    idleObserverRegistered: boolean;
    lastRefreshAttemptMs: number;
    lastSuccessfulRefreshMs: number;
    idleObserver: {
        QueryInterface: ReturnType<typeof ChromeUtils.generateQI>;
        observe: (subject: any, topic: string, data: string) => void;
    };
}

function getSharedState(): SessionHealthState {
    if (!Zotero.__beaverSessionHealth) {
        Zotero.__beaverSessionHealth = {
            refCount: 0,
            idleObserverRegistered: false,
            lastRefreshAttemptMs: 0,
            lastSuccessfulRefreshMs: 0,
            idleObserver: {
                QueryInterface: ChromeUtils.generateQI(['nsIObserver']),
                observe(_subject: any, topic: string, _data: string) {
                    if (topic === 'active') {
                        logger('useSessionHealth: User returned from idle/sleep');
                        const mainWin = Zotero.getMainWindow();
                        if (mainWin) {
                            mainWin.setTimeout(() => {
                                proactiveSessionRefresh('idle-active');
                            }, WAKE_DELAY_MS);
                        }
                    }
                },
            },
        };
    }
    return Zotero.__beaverSessionHealth;
}

// ---------------------------------------------------------------------------
// Proactive refresh — shared by both layers
// ---------------------------------------------------------------------------
async function proactiveSessionRefresh(trigger: string): Promise<void> {
    const state = getSharedState();
    const now = Date.now();

    // Rate-limit: skip if we attempted a refresh recently
    if (now - state.lastRefreshAttemptMs < RATE_LIMIT_MS) {
        logger(`useSessionHealth: Skipping refresh (trigger=${trigger}, rate-limited)`);
        return;
    }
    state.lastRefreshAttemptMs = now;

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            logger(`useSessionHealth: No session to refresh (trigger=${trigger})`);
            return;
        }

        const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
        const expiresInMs = expiresAt - now;
        logger(
            `useSessionHealth: Refreshing session (trigger=${trigger}, ` +
            `expiresIn=${Math.round(expiresInMs / 1000)}s, ` +
            `lastAutoRefresh=${Math.round((now - lastAutoRefreshSuccessMs) / 1000)}s ago)`,
        );

        const { error } = await supabase.auth.refreshSession();
        if (error) {
            logger(`useSessionHealth: Refresh failed (trigger=${trigger}): ${error.message}`, 2);
        } else {
            state.lastSuccessfulRefreshMs = Date.now();
            logger(`useSessionHealth: Refresh succeeded (trigger=${trigger})`);
        }
    } catch (err) {
        logger(`useSessionHealth: Refresh threw (trigger=${trigger}): ${err}`, 2);
    }
}

// ---------------------------------------------------------------------------
// Diagnostics export — used by useAuth for SIGNED_OUT logging
// ---------------------------------------------------------------------------
export function getSessionHealthDiagnostics() {
    const state = getSharedState();
    const now = Date.now();
    return {
        lastRefreshAttemptSecsAgo: state.lastRefreshAttemptMs ? Math.round((now - state.lastRefreshAttemptMs) / 1000) : null,
        lastSuccessfulRefreshSecsAgo: state.lastSuccessfulRefreshMs ? Math.round((now - state.lastSuccessfulRefreshMs) / 1000) : null,
        lastAutoRefreshSuccessSecsAgo: lastAutoRefreshSuccessMs ? Math.round((now - lastAutoRefreshSuccessMs) / 1000) : null,
        idleObserverRegistered: state.idleObserverRegistered,
    };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useSessionHealth() {
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const prevSidebarVisibleRef = useRef(isSidebarVisible);

    // Layer 1: Idle observer registration (cross-window singleton with ref-counting)
    useEffect(() => {
        const state = getSharedState();
        state.refCount++;
        logger(`useSessionHealth: mounted, refCount=${state.refCount}`);

        // Register idle observer only if we're the first mount across all windows
        if (!state.idleObserverRegistered) {
            try {
                const idleService = Cc['@mozilla.org/widget/useridleservice;1']
                    .getService(Ci.nsIUserIdleService);
                idleService.addIdleObserver(state.idleObserver, IDLE_TIMEOUT_S);
                state.idleObserverRegistered = true;
                logger(`useSessionHealth: Registered idle observer (timeout=${IDLE_TIMEOUT_S}s)`);
            } catch (err) {
                logger(`useSessionHealth: Failed to register idle observer: ${err}`, 2);
            }
        } else {
            logger('useSessionHealth: Idle observer already registered by another window, skipping');
        }

        return () => {
            state.refCount--;
            logger(`useSessionHealth: unmounted, refCount=${state.refCount}`);
            if (state.refCount <= 0) {
                cleanupIdleObserver();
            }
        };
    }, []);

    // Layer 2: Sidebar visibility — refresh on false → true transition
    useEffect(() => {
        const wasVisible = prevSidebarVisibleRef.current;
        prevSidebarVisibleRef.current = isSidebarVisible;

        // Only act on false → true transitions
        if (!wasVisible && isSidebarVisible) {
            const session = store.get(sessionAtom);
            if (!session) return;

            const now = Date.now();
            const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
            const expiresInMs = expiresAt - now;

            if (expiresInMs < EXPIRY_BUFFER_MS) {
                logger(
                    `useSessionHealth: Sidebar opened, token ${expiresInMs <= 0 ? 'expired' : `expires in ${Math.round(expiresInMs / 1000)}s`} — refreshing`,
                );
                proactiveSessionRefresh('sidebar-visible');
            }
        }
    }, [isSidebarVisible]);
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------
function cleanupIdleObserver() {
    const state = getSharedState();
    if (!state.idleObserverRegistered) return;
    try {
        const idleService = Cc['@mozilla.org/widget/useridleservice;1']
            .getService(Ci.nsIUserIdleService);
        idleService.removeIdleObserver(state.idleObserver, IDLE_TIMEOUT_S);
        state.idleObserverRegistered = false;
        logger('useSessionHealth: Unregistered idle observer');
    } catch (err) {
        logger(`useSessionHealth: Failed to unregister idle observer: ${err}`, 2);
    }
}
