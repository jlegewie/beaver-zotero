import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { getCredentialGeneration } from '@beaver/agent-core/transport/credentials';
import { store } from '../store';
import { getWindowRuntime } from '../runtime/windowRuntime';
import { useSurfaceWindow } from '../runtime/SurfaceWindowContext';
import { useChatReconnect } from './useChatReconnect';
import { userAtom } from '../atoms/auth';
import { showAllThreadInstancesAtom } from '../atoms/ui';
import { ThreadData, loadThreadAtom, newThreadAtom } from '../atoms/threads';
import {
    threadEntitiesAtom,
    threadViewsAtom,
    threadViewKey,
    resolveThreadView,
    selectPinnedThreads,
    loadThreadPageAtom,
    loadMoreThreadsAtom,
    loadPinnedThreadsAtom,
    setThreadPinnedAtom,
    pinsPendingAtom,
    isPinPending,
    EMPTY_THREAD_VIEW,
} from '../atoms/threadList';
import { currentZoteroInstanceRef } from '../../src/utils/zoteroUtils';
import { groupThreadsByDate, type ThreadDateGroupRows } from '../utils/threadDateGroups';
import type { ChatLoadError } from '../../src/services/threads/chatLoadError';

/** Stable identity for "no rows", so the memos below are not invalidated per render. */
const EMPTY_THREADS: ThreadData[] = [];

export interface ThreadHistory {
    /** The raw search text, as the input shows it. */
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    /** The debounced query the list is showing results for. */
    activeQuery: string;
    /** Applies the typed query immediately, or reloads when it is already showing. */
    submitSearch: () => void;
    isLoading: boolean;
    error: ChatLoadError | null;
    hasMore: boolean;
    loadMore: () => void;
    reload: () => void;
    /** Pinned chats; empty while searching, which shows only its results. */
    pinnedThreads: ThreadData[];
    /** The unpinned chats of the view, grouped by date. */
    groups: ThreadDateGroupRows[];
    /** Whether the view has any row at all. */
    hasRows: boolean;
    currentThreadId: string | null;
    isPinPending: (threadId: string) => boolean;
    selectThread: (thread: ThreadData) => Promise<boolean>;
    togglePin: (thread: ThreadData) => void;
    renameThread: (threadId: string, name: string) => Promise<void>;
    /** Confirms with the user, then deletes. Resolves to whether it was deleted. */
    deleteThread: (threadId: string) => Promise<boolean>;
}

/**
 * The chat history as a list: loading, search, pinned group, date groups and
 * the row actions. Renders from the normalized thread store, so every surface
 * that shows history stays in step without notifying the others.
 *
 * Scoped to the current Zotero profile unless the user opted into showing all
 * instances (`showAllThreadInstancesAtom`).
 */
export function useThreadHistory(): ThreadHistory {
    const surfaceWindow = useSurfaceWindow();
    const user = useAtomValue(userAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const showAllInstances = useAtomValue(showAllThreadInstancesAtom);
    const entities = useAtomValue(threadEntitiesAtom);
    const views = useAtomValue(threadViewsAtom);
    const pinsPending = useAtomValue(pinsPendingAtom);
    const loadPage = useSetAtom(loadThreadPageAtom);
    const loadMoreThreads = useSetAtom(loadMoreThreadsAtom);
    const loadPinned = useSetAtom(loadPinnedThreadsAtom);
    const setThreadPinned = useSetAtom(setThreadPinnedAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const newThread = useSetAtom(newThreadAtom);

    const [searchQuery, setSearchQuery] = useState('');
    const [activeQuery, setActiveQuery] = useState('');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Read live — the Zotero account id can appear or disappear when the user
    // logs in or out without this hook's host remounting. Memoized on its
    // values because the helper returns a fresh object each call.
    const liveInstance = currentZoteroInstanceRef();
    const instanceUserId = liveInstance?.zoteroUserId ?? null;
    const instanceLocalId = liveInstance?.zoteroLocalId ?? null;
    const instanceRef = useMemo(
        () => (instanceUserId === null && instanceLocalId === null
            ? null
            : { zoteroUserId: instanceUserId, zoteroLocalId: instanceLocalId }),
        [instanceUserId, instanceLocalId]
    );
    const scope = showAllInstances ? undefined : (instanceRef ?? undefined);

    const viewKey = useMemo(
        () => (user
            ? threadViewKey({ userId: user.id, query: activeQuery, showAll: showAllInstances, scope: instanceRef })
            : ''),
        [user, activeQuery, showAllInstances, instanceRef]
    );
    const view = views.get(viewKey) ?? EMPTY_THREAD_VIEW;
    const isLoading = view.status === 'loading';

    useEffect(() => {
        if (!user) return;
        loadPage({ key: viewKey, query: activeQuery, scope, includeOtherCount: scope !== undefined });
    }, [user, viewKey, activeQuery, scope, loadPage, view.loadedAt]);

    // Pinned chats reach further back than the paginated window, so they are
    // a second discovery query into the same view. A search shows only its
    // results, so only the plain list needs them.
    const showPinnedGroup = !activeQuery;
    useEffect(() => {
        if (!user || !showPinnedGroup) return;
        loadPinned({ key: viewKey, scope });
    }, [user, showPinnedGroup, viewKey, scope, loadPinned, view.pinnedLoadedAt]);

    // Debounced search
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (searchQuery === activeQuery) return;
        debounceRef.current = setTimeout(() => setActiveQuery(searchQuery), 400);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [searchQuery, activeQuery]);

    const reload = useCallback(() => {
        if (!user) return;
        loadPage({ key: viewKey, query: activeQuery, scope, includeOtherCount: scope !== undefined, force: true });
        if (showPinnedGroup) loadPinned({ key: viewKey, scope, force: true });
    }, [user, viewKey, activeQuery, scope, showPinnedGroup, loadPage, loadPinned]);

    useChatReconnect(reload, !!view.error);

    const submitSearch = useCallback(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (searchQuery !== activeQuery) {
            setActiveQuery(searchQuery);
        } else {
            reload();
        }
    }, [searchQuery, activeQuery, reload]);

    const loadMore = useCallback(() => {
        loadMoreThreads({ key: viewKey, query: activeQuery, scope });
    }, [loadMoreThreads, viewKey, activeQuery, scope]);

    const rows = useMemo(() => resolveThreadView(view, entities), [view, entities]);

    // The Pinned group is taken over every known chat, not over this view's
    // window: pinning from elsewhere must show up here even when the paginated
    // query has not reached that chat. The date groups are the window minus
    // whatever the group took, so a chat cannot render twice.
    const pinnedThreads = useMemo(
        () => (showPinnedGroup ? selectPinnedThreads(entities, scope) : EMPTY_THREADS),
        [showPinnedGroup, entities, scope]
    );
    const groups = useMemo(
        () => groupThreadsByDate(showPinnedGroup ? rows.filter(t => !t.isPinned) : rows),
        [showPinnedGroup, rows]
    );

    const selectThread = useCallback(async (thread: ThreadData): Promise<boolean> => {
        if (!user) return false;
        if (thread.id === currentThreadId) return true;
        try {
            return await loadThread({
                window: surfaceWindow,
                user_id: user.id,
                threadId: thread.id,
                threadName: thread.name,
                threadIdentity: {
                    zoteroUserId: thread.zoteroUserId ?? null,
                    zoteroLocalId: thread.zoteroLocalId ?? null,
                },
            });
        } catch (error) {
            console.error('Error loading thread:', error);
            return false;
        }
    }, [user, currentThreadId, loadThread, surfaceWindow]);

    // The store owns confirmation/reconciliation and the one-toggle-at-a-time
    // guard, so this is just the call.
    const togglePin = useCallback((thread: ThreadData) => {
        void setThreadPinned({ threadId: thread.id, pinned: !thread.isPinned, viewKey });
    }, [setThreadPinned, viewKey]);

    const renameThread = useCallback(async (threadId: string, name: string) => {
        const trimmed = name.trim();
        if (!threadId || !trimmed) return;
        try {
            await Zotero.Beaver.threads.renameThread(threadId, trimmed);
        } catch (error) {
            console.error('Error renaming thread:', error);
        }
    }, []);

    const deleteThread = useCallback(async (threadId: string): Promise<boolean> => {
        const buttonIndex = Zotero.Prompt.confirm({
            window: surfaceWindow,
            title: 'Delete chat?',
            text: 'Are you sure you want to delete this chat? This action cannot be undone.',
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return false;
        try {
            await Zotero.Beaver.threads.deleteThread(threadId, getWindowRuntime().id, getCredentialGeneration());
            // The delete was confirmed; leave only if this is still the open chat.
            if (threadId === store.get(currentThreadIdAtom)) {
                await newThread({ skipActiveRunConfirm: true, window: surfaceWindow });
            }
            return true;
        } catch (error) {
            console.error('Error deleting thread:', error);
            return false;
        }
    }, [surfaceWindow, newThread]);

    const isPinPendingFor = useCallback(
        (threadId: string) => isPinPending(pinsPending, threadId),
        [pinsPending]
    );

    return {
        searchQuery,
        setSearchQuery,
        activeQuery,
        submitSearch,
        isLoading,
        error: view.error,
        hasMore: view.hasMore,
        loadMore,
        reload,
        pinnedThreads,
        groups,
        hasRows: rows.length > 0 || pinnedThreads.length > 0,
        currentThreadId,
        isPinPending: isPinPendingFor,
        selectThread,
        togglePin,
        renameThread,
        deleteThread,
    };
}
