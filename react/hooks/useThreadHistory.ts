import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { useSurfaceWindow } from '../runtime/SurfaceWindowContext';
import { useChatReconnect } from './useChatReconnect';
import { userAtom } from '../atoms/auth';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { showAllThreadInstancesAtom } from '../atoms/ui';
import { ThreadData, loadThreadAtom } from '../atoms/threads';
import {
    threadEntitiesAtom,
    threadViewsAtom,
    threadViewKey,
    resolveThreadView,
    selectPinnedThreads,
    loadThreadPageAtom,
    loadMoreThreadsAtom,
    loadPinnedThreadsAtom,
    loadThreadsByItemAtom,
    setThreadPinnedAtom,
    pinsPendingAtom,
    isPinPending,
    EMPTY_THREAD_VIEW,
} from '../atoms/threadList';
import { currentZoteroInstanceRef } from '../../src/utils/zoteroUtils';
import { isThreadInstanceMismatch } from '../../src/services/threads/threadMatches';
import { groupThreadsByDate, type ThreadDateGroupRows } from '../utils/threadDateGroups';
import { confirmAndDeleteThread, renameThread as renameThreadAction } from '../utils/threadActions';
import type { ThreadItemFilter, ThreadListViewState } from '../../src/services/threads/types';

/** Stable identity for "no rows", so the memos below are not invalidated per render. */
const EMPTY_THREADS: ThreadData[] = [];

export interface ThreadInstanceRef {
    zoteroUserId: string | null;
    zoteroLocalId: string | null;
}

export interface UseThreadHistoryOptions {
    /**
     * Show only chats about this item. Item-filtered mode answers a different
     * question, so it uses its own loader and partitions client-side.
     */
    filter?: ThreadItemFilter | null;
    /** Called when the filter's library is no longer searchable, so the caller can drop it. */
    onFilterUnavailable?: () => void;
}

export interface ThreadHistory {
    /** The raw search text, as the input shows it. */
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    /** The debounced query the list is showing results for. */
    activeQuery: string;
    /** Applies the typed query immediately, or reloads when it is already showing. */
    submitSearch: () => void;
    isLoading: boolean;
    view: ThreadListViewState;
    viewKey: string;
    loadMore: () => void;
    reload: () => void;
    /** This Zotero profile, or null when it has no identity yet. */
    instanceRef: ThreadInstanceRef | null;
    /** The instance scope the list is loaded for; undefined when showing all profiles. */
    scope: ThreadInstanceRef | undefined;
    /** Every row of the view, before instance and query filtering. */
    rows: ThreadData[];
    /** The rows on screen: pinned group plus date groups. */
    visibleRows: ThreadData[];
    /** Whether the Pinned group is shown. Off while searching or filtering by item. */
    showPinnedGroup: boolean;
    /** Pinned chats; empty when the group is not shown. */
    pinnedThreads: ThreadData[];
    /** The unpinned visible rows, grouped by date. */
    groups: ThreadDateGroupRows[];
    currentThreadId: string | null;
    isPinPending: (threadId: string) => boolean;
    /** Opens the chat. Resolves to whether it is now the open chat. */
    selectThread: (thread: ThreadData) => Promise<boolean>;
    togglePin: (thread: ThreadData) => void;
    renameThread: (threadId: string, name: string) => Promise<void>;
    /** Confirms with the user, then deletes. */
    deleteThread: (threadId: string) => Promise<void>;
}

/**
 * The chat history as a list: loading, search, pinned group, date groups and
 * the row actions. Renders from the normalized thread store, so every surface
 * that shows history stays in step without notifying the others.
 *
 * Scoped to the current Zotero profile unless the user opted into showing all
 * instances (`showAllThreadInstancesAtom`).
 */
export function useThreadHistory({ filter = null, onFilterUnavailable }: UseThreadHistoryOptions = {}): ThreadHistory {
    const surfaceWindow = useSurfaceWindow();
    const user = useAtomValue(userAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const showAllInstances = useAtomValue(showAllThreadInstancesAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const entities = useAtomValue(threadEntitiesAtom);
    const views = useAtomValue(threadViewsAtom);
    const pinsPending = useAtomValue(pinsPendingAtom);
    const loadPage = useSetAtom(loadThreadPageAtom);
    const loadMoreThreads = useSetAtom(loadMoreThreadsAtom);
    const loadPinned = useSetAtom(loadPinnedThreadsAtom);
    const loadByItem = useSetAtom(loadThreadsByItemAtom);
    const setThreadPinned = useSetAtom(setThreadPinnedAtom);
    const loadThread = useSetAtom(loadThreadAtom);

    const [searchQuery, setSearchQuery] = useState('');
    const [activeQuery, setActiveQuery] = useState('');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Read live — the Zotero account id can appear or disappear when the user
    // logs in or out without this hook's host remounting. Memoized on its
    // values because the helper returns a fresh object each call.
    const liveInstance = currentZoteroInstanceRef();
    const instanceUserId = liveInstance?.zoteroUserId ?? null;
    const instanceLocalId = liveInstance?.zoteroLocalId ?? null;
    const instanceRef = useMemo<ThreadInstanceRef | null>(
        () => (instanceUserId === null && instanceLocalId === null
            ? null
            : { zoteroUserId: instanceUserId, zoteroLocalId: instanceLocalId }),
        [instanceUserId, instanceLocalId]
    );
    const scope = showAllInstances ? undefined : (instanceRef ?? undefined);

    // Which view this render is showing. Search, item filter and instance scope
    // each produce a different one, so a response can only ever land in the
    // view that asked for it.
    const viewKey = useMemo(
        () => (user
            ? threadViewKey({ userId: user.id, query: filter ? '' : activeQuery, showAll: showAllInstances, scope: instanceRef, filter })
            : ''),
        [user, activeQuery, showAllInstances, instanceRef, filter]
    );
    const view = views.get(viewKey) ?? EMPTY_THREAD_VIEW;
    const isLoading = view.status === 'loading';

    // Load this view. Item-filtered mode uses its own loader; both merge into
    // the same entity store.
    useEffect(() => {
        if (!user) return;
        if (filter) {
            // Exclusions can change (Beaver Preferences) while the view is open,
            // so re-check at load time instead of trusting a stale atom.
            if (!searchableLibraryIds.includes(filter.libraryId)) {
                onFilterUnavailable?.();
                return;
            }
            loadByItem({ key: viewKey, filter });
            return;
        }
        loadPage({
            key: viewKey,
            query: activeQuery,
            scope,
            // Only a scoped first page can report how many threads scoping hides.
            includeOtherCount: scope !== undefined,
        });
    }, [user, viewKey, filter, activeQuery, scope, searchableLibraryIds, loadPage, loadByItem, onFilterUnavailable, view.loadedAt]);

    // Pinned chats reach further back than the paginated window, so they are
    // a second discovery query into the same view. A search shows only its
    // results and an item filter answers "chats about X", so neither shows
    // the group.
    const showPinnedGroup = !activeQuery && !filter;
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

    /** Reloads the current view from the server, ignoring its freshness. */
    const reload = useCallback(() => {
        if (!user) return;
        if (filter) {
            loadByItem({ key: viewKey, filter, force: true });
            return;
        }
        loadPage({ key: viewKey, query: activeQuery, scope, includeOtherCount: scope !== undefined, force: true });
        if (showPinnedGroup) loadPinned({ key: viewKey, scope, force: true });
    }, [user, filter, viewKey, activeQuery, scope, showPinnedGroup, loadPage, loadByItem, loadPinned]);

    useChatReconnect(reload, !!view.error);

    const submitSearch = useCallback(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (searchQuery !== activeQuery) {
            setActiveQuery(searchQuery);
        } else {
            // Already showing this query — asks for fresh results.
            reload();
        }
    }, [searchQuery, activeQuery, reload]);

    const loadMore = useCallback(() => {
        loadMoreThreads({ key: viewKey, query: activeQuery, scope });
    }, [loadMoreThreads, viewKey, activeQuery, scope]);

    /** The view's rows, newest first, with dead ids dropped. */
    const rows = useMemo(() => resolveThreadView(view, entities), [view, entities]);

    // Item-filtered mode fetches unscoped and partitions client-side (the
    // deduplicated match set is bounded); the other modes are server-scoped.
    const visibleRows = useMemo(() => {
        let visible = rows;
        if (filter && !showAllInstances) {
            visible = visible.filter(t => !isThreadInstanceMismatch(instanceRef, {
                zoteroUserId: t.zoteroUserId, zoteroLocalId: t.zoteroLocalId,
            }));
        }
        if (filter && activeQuery) {
            visible = visible.filter(t => (t.name || 'Unnamed conversation').toLowerCase().includes(activeQuery.toLowerCase()));
        }
        return visible;
    }, [filter, activeQuery, rows, showAllInstances, instanceRef]);

    // The Pinned group is taken over every known chat, not over this view's
    // window: pinning from elsewhere must show up here even when the paginated
    // query has not reached that chat. The date groups are the window minus
    // whatever the group took, so a chat cannot render twice.
    const pinnedThreads = useMemo(
        () => (showPinnedGroup ? selectPinnedThreads(entities, scope) : EMPTY_THREADS),
        [showPinnedGroup, entities, scope]
    );
    const groups = useMemo(
        () => groupThreadsByDate(showPinnedGroup ? visibleRows.filter(t => !t.isPinned) : visibleRows),
        [showPinnedGroup, visibleRows]
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

    const deleteThread = useCallback(async (threadId: string) => {
        await confirmAndDeleteThread(threadId, surfaceWindow);
    }, [surfaceWindow]);

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
        view,
        viewKey,
        loadMore,
        reload,
        instanceRef,
        scope,
        rows,
        visibleRows,
        showPinnedGroup,
        pinnedThreads,
        groups,
        currentThreadId,
        isPinPending: isPinPendingFor,
        selectThread,
        togglePin,
        renameThread: renameThreadAction,
        deleteThread,
    };
}
