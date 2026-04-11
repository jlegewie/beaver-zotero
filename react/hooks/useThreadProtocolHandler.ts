/**
 * Hook that listens for "loadThread" events dispatched by the zotero://beaver
 * protocol handler and loads the requested thread in the sidebar.
 *
 * Also restores a thread persisted by the update controller when a plugin
 * upgrade ran. Two paths:
 *   - If the sidebar was open at persist time, the update was deferred and
 *     the user will eventually close the sidebar; after the upgrade the
 *     sidebar is force-opened and the thread is loaded (seamless resume).
 *   - If the sidebar was closed at persist time, the update ran through
 *     immediately; we silently pre-load the thread in the background so the
 *     next time the user opens Beaver it's already there — no sidebar
 *     force-open, which would be intrusive.
 */

import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { currentThreadIdAtom, loadThreadAtom, pendingScrollToRunAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { logger } from '../../src/utils/logger';
import { getPref, clearPref } from '../../src/utils/prefs';

interface PendingProtocolTarget {
    threadId: string;
    runId?: string;
}

/** Max age for a persisted-deferred-thread pref to be considered fresh. */
const DEFERRED_THREAD_WINDOW_MS = 10 * 60 * 1000;

interface DeferredThreadPayload {
    threadId: string;
    setAt: number;
    sidebarWasOpen: boolean;
}

function readDeferredThreadPref(): DeferredThreadPayload | null {
    try {
        const raw = getPref('pendingDeferredThread');
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<DeferredThreadPayload>;
        if (!parsed || typeof parsed.threadId !== 'string' || typeof parsed.setAt !== 'number') {
            return null;
        }
        if (Date.now() - parsed.setAt > DEFERRED_THREAD_WINDOW_MS) {
            return null; // stale
        }
        return {
            threadId: parsed.threadId,
            setAt: parsed.setAt,
            sidebarWasOpen: Boolean(parsed.sidebarWasOpen),
        };
    } catch {
        return null;
    }
}

export function useThreadProtocolHandler() {
    const user = useAtomValue(userAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const setPendingScrollToRun = useSetAtom(pendingScrollToRunAtom);
    const pendingTargetRef = useRef<PendingProtocolTarget | null>(null);
    const didHandleDeferredRestoreRef = useRef(false);

    const loadTargetThread = (threadId: string, userId: string, runId?: string) => {
        // If the thread is already open, skip reloading — just scroll to the run if requested.
        if (threadId === currentThreadId) {
            logger(`useThreadProtocolHandler: Thread ${threadId} already open, skipping reload${runId ? ` — scrolling to run ${runId}` : ''}`);
            setPendingScrollToRun(runId ?? null);
            return;
        }

        logger(`useThreadProtocolHandler: Loading thread ${threadId}${runId ? ` / run ${runId}` : ''}`);

        // Set/clear scroll target before loading so ThreadView picks up only the current protocol target.
        setPendingScrollToRun(runId ?? null);

        // Load the thread
        loadThread({ user_id: userId, threadId });
    };

    // One-shot: consume a deferred-thread pref written by the src/ update
    // controller before the plugin was upgraded. Runs once per hook mount and
    // is guarded by a ref so React strict-mode double-invocation is safe.
    useEffect(() => {
        if (didHandleDeferredRestoreRef.current) return;
        didHandleDeferredRestoreRef.current = true;

        const payload = readDeferredThreadPref();
        // Clear regardless of validity so a corrupt pref self-heals on next mount.
        try {
            clearPref('pendingDeferredThread');
        } catch {
            /* ignore */
        }

        if (!payload) return;

        logger(
            `useThreadProtocolHandler: Restoring deferred thread ${payload.threadId} (sidebarWasOpen=${payload.sidebarWasOpen})`,
        );

        // Queue the thread for loading once auth is ready. The existing
        // pending-target effect below picks it up when `user` resolves.
        pendingTargetRef.current = { threadId: payload.threadId };

        // Only force-open the sidebar if it was visible at persist time.
        // When the sidebar was closed, the user never saw it close for the
        // upgrade, so we shouldn't surprise them by popping it open — the
        // thread is pre-loaded silently and appears when they next open Beaver.
        if (payload.sidebarWasOpen) {
            try {
                eventManager.dispatch('toggleChat', { forceOpen: true });
            } catch {
                /* ignore — dispatch race during early mount */
            }
        }
    }, []);

    useEventSubscription('loadThread', (detail) => {
        const { threadId, runId } = detail;

        // Always open Beaver, even when the user is logged out.
        eventManager.dispatch('toggleChat', { forceOpen: true });

        if (!user) {
            pendingTargetRef.current = { threadId, runId };
            logger('useThreadProtocolHandler: No authenticated user, opening sidebar and deferring thread load');
            return;
        }

        loadTargetThread(threadId, user.id, runId);
    }, [user, currentThreadId, loadThread, setPendingScrollToRun]);

    useEffect(() => {
        if (!user || !pendingTargetRef.current) return;

        const { threadId, runId } = pendingTargetRef.current;
        pendingTargetRef.current = null;
        logger(`useThreadProtocolHandler: Resuming deferred thread load ${threadId}${runId ? ` / run ${runId}` : ''}`);
        loadTargetThread(threadId, user.id, runId);
    }, [user, currentThreadId, loadThread, setPendingScrollToRun]);
}
