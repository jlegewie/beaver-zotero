import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { SearchIcon, EditIcon, DeleteIcon, TickIcon, CancelIcon } from './icons/icons';
import Spinner from './icons/Spinner';
import IconButton from './ui/IconButton';
import { isThreadListViewAtom, threadListFilterAtom, showAllThreadInstancesAtom } from '../atoms/ui';
import { ThreadData, loadThreadAtom, newThreadAtom } from '../atoms/threads';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { userAtom } from '../atoms/auth';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { threadService, isThreadAgentMismatch } from '@beaver/agent-core/transport/threadService';
import { currentZoteroInstanceRef } from '../../src/utils/zoteroUtils';
import { getDateGroup } from '../utils/dateUtils';
import { formatTimeAgo } from '../utils/formatTimeAgo';
import { buildThreadItemFilter } from '../utils/threadItemFilter';
import { deduplicateByThread, threadModelToThreadData, isThreadInstanceMismatch } from '../utils/threadMatches';
import Button from './ui/Button';
import { ChipButton } from './agentRuns/requestChips/ChipButton';
import { CSSIcon, CSSItemTypeIcon } from './icons/zotero';
import ThreadFilterMenu from './ui/menus/ThreadFilterMenu';
import Tooltip from './ui/Tooltip';
import { clearRecentChatsCache } from './RecentChats';
import { isTransientNetworkError } from '../utils/isTransientNetworkError';

type FetchError = { offline: boolean } | null;

interface ThreadListViewProps {
    isWindow?: boolean;
}

interface CacheEntry {
    threads: ThreadData[];
    hasMore: boolean;
    nextCursor: string | null;
    timestamp: number;
    // Last known count of threads hidden by instance scoping for this variant;
    // null when the response didn't carry one (search, later pages).
    otherInstanceCount?: number | null;
}

const PAGE_SIZE = 15;
const CACHE_TTL = 60_000; // 1 minute

// Marks a chat created in a different Zotero install. Always says "Zotero" —
// a bare "account" would read as the user's Beaver account, which never
// differs here. A mismatch always implies a different profile (see
// `isThreadInstanceMismatch`), so one label covers every case.
const FOREIGN_THREAD_LABEL = 'Other Zotero profile';
const FOREIGN_THREAD_TITLE = 'Created in a different Zotero account or profile';

/**
 * Cache key for a thread-list fetch. Includes the live instance identity so
 * enabling/logging into Zotero (or switching accounts) cannot reuse a prior
 * identity's scoped results under the same "scoped" bucket.
 */
function threadListCacheKey(
    userId: string,
    query: string,
    showAll: boolean,
    scope: { zoteroUserId?: string | null; zoteroLocalId?: string | null } | null | undefined
): string {
    if (showAll) return `${userId}:${query}:all`;
    return `${userId}:${query}:scoped:${scope?.zoteroUserId ?? ''}:${scope?.zoteroLocalId ?? ''}`;
}

// Module-level cache: persists across mount/unmount cycles
const searchCache = new Map<string, CacheEntry>();

export function clearThreadListCache() {
    searchCache.clear();
}

const highlightMatch = (text: string, query: string): React.ReactNode => {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
        <>
            {text.slice(0, idx)}
            <span className="font-color-accent-blue">{text.slice(idx, idx + query.length)}</span>
            {text.slice(idx + query.length)}
        </>
    );
};

const groupThreadsByDate = (threads: ThreadData[]) => {
    const groups: Record<string, ThreadData[]> = {
        'Today': [],
        'Yesterday': [],
        'This Week': [],
        'This Month': [],
        'Older': [],
    };
    threads.forEach(thread => {
        const group = getDateGroup(thread.updatedAt);
        groups[group].push(thread);
    });
    return groups;
};

const ThreadListView: React.FC<ThreadListViewProps> = ({ isWindow: _isWindow }) => {
    const setIsThreadListView = useSetAtom(isThreadListViewAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const newThread = useSetAtom(newThreadAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const user = useAtomValue(userAtom);
    const filter = useAtomValue(threadListFilterAtom);
    const setFilter = useSetAtom(threadListFilterAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);

    const [threads, setThreads] = useState<ThreadData[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [fetchError, setFetchError] = useState<FetchError>(null);

    // Instance scoping: hide threads stamped by other Zotero accounts/installs
    // by default; "Show all" reveals them. Read live — the Zotero account id
    // can appear/disappear when the user logs in or out without remounting.
    const instanceRef = currentZoteroInstanceRef();
    // Global so the choice survives closing and reopening the thread list.
    const showAllInstances = useAtomValue(showAllThreadInstancesAtom);
    const setShowAllInstances = useSetAtom(showAllThreadInstancesAtom);
    // Read inside fetch callbacks (kept out of their deps so toggling in
    // item-filtered mode doesn't trigger a needless by-item refetch). Seeded
    // from the atom so the first fetch after a remount honors a prior opt-out.
    const showAllInstancesRef = useRef(showAllInstances);
    const [otherInstanceCount, setOtherInstanceCount] = useState<number | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [activeQuery, setActiveQuery] = useState('');
    const activeQueryRef = useRef('');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Guards against a stale in-flight fetch (e.g. from a filter that was
    // just replaced or cleared) overwriting state set by a newer one.
    const fetchSeqRef = useRef(0);

    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [isSavingRename, setIsSavingRename] = useState(false);
    const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const menuPortalContainer = containerRef.current?.closest('[id^="beaver-react-root-"], #beaver-pane-window') as HTMLElement | null;
    const searchInputRef = useRef<HTMLInputElement | null>(null);

    // The filter menu's own search input holds focus while the menu is open
    // and nothing restores it on close, so refocus after the close settles.
    const focusSearchInput = () => {
        setTimeout(() => searchInputRef.current?.focus(), 5);
    };

    useEffect(() => {
        activeQueryRef.current = activeQuery;
    }, [activeQuery]);

    // Keeps the ref honest if the atom is changed outside this component.
    useEffect(() => {
        showAllInstancesRef.current = showAllInstances;
    }, [showAllInstances]);

    // Fetch threads (initial load or after search)
    const fetchThreads = useCallback(async (query: string) => {
        if (!user) return;

        // Invalidate any earlier request before taking a synchronous path
        // (such as a cache hit) so stale results cannot overwrite it later.
        const seq = ++fetchSeqRef.current;

        if (filter) {
            // Exclusions can change (Beaver Preferences) while the view is
            // open, so re-check at fetch time instead of trusting the atom.
            if (!searchableLibraryIds.includes(filter.libraryId)) {
                // Do not leave item-filtered rows visible after removing the
                // filter chip. The atom update below triggers the unfiltered
                // fetch on the next render.
                setThreads([]);
                setHasMore(false);
                setNextCursor(null);
                setFetchError(null);
                setIsLoading(true);
                setFilter(null);
                return;
            }

            setThreads([]);
            setIsLoading(true);
            try {
                const matches = await threadService.findThreadsByItem(
                    { libraryId: filter.libraryId, libraryRef: filter.libraryRef },
                    filter.keys,
                    'both'
                );
                // The by-item route takes no agent scope, so drop another
                // client's threads here (the other lists are scoped server-side).
                const deduped = deduplicateByThread(matches.filter(m => !isThreadAgentMismatch(m)));
                if (seq === fetchSeqRef.current) {
                    setThreads(deduped);
                    setHasMore(false);
                    setNextCursor(null);
                    setFetchError(null);
                }
            } catch (error) {
                console.error('Error fetching threads by item:', error);
                if (seq === fetchSeqRef.current) {
                    if (isTransientNetworkError(error)) {
                        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
                        setFetchError({ offline });
                    } else {
                        setFetchError(null);
                    }
                }
            } finally {
                if (seq === fetchSeqRef.current) setIsLoading(false);
            }
            return;
        }

        const showAll = showAllInstancesRef.current;
        // Live identity for every fetch — do not close over a mount-time snapshot.
        const liveInstance = currentZoteroInstanceRef();
        const scope = showAll ? undefined : (liveInstance ?? undefined);
        const cacheKey = threadListCacheKey(user.id, query, showAll, liveInstance);

        // Check cache with TTL
        const cached = searchCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            setThreads(cached.threads);
            setHasMore(cached.hasMore);
            setNextCursor(cached.nextCursor);
            // Retain the last known count when this variant has none cached.
            if (cached.otherInstanceCount != null) setOtherInstanceCount(cached.otherInstanceCount);
            setFetchError(null);
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        try {
            const response = query
                ? await threadService.searchThreads(query, PAGE_SIZE, null, scope)
                // Only the scoped first page can report how many threads the
                // scoping hides.
                : await threadService.getPaginatedThreads(PAGE_SIZE, null, scope, scope !== undefined);
            const mapped = response.data.map(threadModelToThreadData);
            if (seq === fetchSeqRef.current) {
                setThreads(mapped);
                setNextCursor(response.next_cursor);
                setHasMore(response.has_more);
                // Search responses carry no count — retain the last known one.
                if (response.other_instance_count != null) {
                    setOtherInstanceCount(response.other_instance_count);
                }
            }
            searchCache.set(cacheKey, {
                threads: mapped,
                hasMore: response.has_more,
                nextCursor: response.next_cursor,
                timestamp: Date.now(),
                otherInstanceCount: response.other_instance_count ?? null,
            });
            if (seq === fetchSeqRef.current) setFetchError(null);
        } catch (error) {
            console.error('Error fetching threads:', error);
            if (seq === fetchSeqRef.current) {
                if (isTransientNetworkError(error)) {
                    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
                    setFetchError({ offline });
                } else {
                    setFetchError(null);
                }
            }
        } finally {
            if (seq === fetchSeqRef.current) setIsLoading(false);
        }
    }, [user, filter, searchableLibraryIds]);

    // Toggle between the scoped and all-instances list. Unfiltered mode
    // refetches (cache-hit when warm); item-filtered mode only flips the
    // display partition of the already-fetched matches.
    const toggleShowAllInstances = (next: boolean) => {
        showAllInstancesRef.current = next;
        setShowAllInstances(next);
        if (!filter) fetchThreads(activeQueryRef.current);
    };

    // Initial fetch, and refetch (with the in-progress query) whenever the
    // filter is set/cleared/switched.
    useEffect(() => {
        fetchThreads(activeQueryRef.current);
    }, [fetchThreads]);

    // Debounced search
    useEffect(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
        }
        if (searchQuery === activeQuery) return;

        debounceRef.current = setTimeout(() => {
            setActiveQuery(searchQuery);
            // Filtered mode searches the already-fetched set client-side —
            // no network call or cache invalidation needed.
            if (!filter) fetchThreads(searchQuery);
        }, 400);

        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
        };
    }, [searchQuery, activeQuery, filter, fetchThreads]);

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsThreadListView(false);
            return;
        }
        if (e.key === 'Enter') {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
            setActiveQuery(searchQuery);
            if (filter) return;
            // Invalidate cache for this query to get fresh results on Enter
            if (user) {
                searchCache.delete(threadListCacheKey(
                    user.id,
                    searchQuery,
                    showAllInstancesRef.current,
                    currentZoteroInstanceRef()
                ));
            }
            fetchThreads(searchQuery);
        }
    };

    const handleSelectFilterItem = async (item: Zotero.Item) => {
        const f = await buildThreadItemFilter(item, searchableLibraryIds);
        if (f) setFilter(f);
        focusSearchInput();
    };

    // Load more
    const loadMoreThreads = async () => {
        if (!user || isLoading || filter) return;

        const seq = ++fetchSeqRef.current;
        setIsLoading(true);
        try {
            const showAll = showAllInstancesRef.current;
            const liveInstance = currentZoteroInstanceRef();
            const scope = showAll ? undefined : (liveInstance ?? undefined);
            const cacheKey = threadListCacheKey(user.id, activeQuery, showAll, liveInstance);
            let response;
            if (activeQuery) {
                response = await threadService.searchThreads(activeQuery, PAGE_SIZE, nextCursor, scope);
            } else {
                response = await threadService.getPaginatedThreads(PAGE_SIZE, nextCursor, scope);
            }
            const mapped = response.data.map(threadModelToThreadData);
            const combined = [...threads, ...mapped];
            if (seq === fetchSeqRef.current) {
                setThreads(combined);
                setNextCursor(response.next_cursor);
                setHasMore(response.has_more);
            }
            searchCache.set(cacheKey, {
                threads: combined,
                hasMore: response.has_more,
                nextCursor: response.next_cursor,
                timestamp: Date.now(),
                // Later pages carry no count — keep the variant's last known one.
                otherInstanceCount: searchCache.get(cacheKey)?.otherInstanceCount ?? null,
            });
            if (seq === fetchSeqRef.current) setFetchError(null);
        } catch (error) {
            console.error('Error loading more threads:', error);
            if (seq === fetchSeqRef.current && isTransientNetworkError(error)) {
                const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
                setFetchError({ offline });
            }
        } finally {
            if (seq === fetchSeqRef.current) setIsLoading(false);
        }
    };

    // Thread actions
    const handleSelectThread = async (thread: ThreadData) => {
        if (!user) return;
        // Clicking the already-open thread just closes the list.
        if (thread.id === currentThreadId) {
            setIsThreadListView(false);
            return;
        }
        try {
            const loaded = await loadThread({
                user_id: user.id,
                threadId: thread.id,
                threadName: thread.name,
                threadIdentity: {
                    zoteroUserId: thread.zoteroUserId ?? null,
                    zoteroLocalId: thread.zoteroLocalId ?? null,
                },
            });
            // Keep the list open when the load was aborted (e.g. the user
            // canceled the other-instance confirm) or failed.
            if (loaded) setIsThreadListView(false);
        } catch (error) {
            console.error('Error loading thread:', error);
        }
    };

    const handleDelete = async (threadId: string) => {
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: 'Delete chat?',
            text: 'Are you sure you want to delete this chat? This action cannot be undone.',
            button0: Zotero.Prompt.BUTTON_TITLE_YES,
            button1: Zotero.Prompt.BUTTON_TITLE_NO,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;

        try {
            await threadService.deleteThread(threadId);
            setThreads(prev => prev.filter(t => t.id !== threadId));
            // Invalidate caches
            searchCache.clear();
            clearRecentChatsCache(threadId);
            // If deleting the current thread, create a new one. The user already
            // confirmed the delete above, so skip the active-run confirmation.
            if (threadId === currentThreadId) {
                await newThread({ skipActiveRunConfirm: true });
            }
        } catch (error) {
            console.error('Error deleting thread:', error);
        }
    };

    const handleStartRename = (threadId: string, currentName: string) => {
        setEditingThreadId(threadId);
        setEditingName(currentName || 'Unnamed conversation');
    };

    const handleCancelRename = () => {
        setEditingThreadId(null);
    };

    const handleConfirmRename = async (threadId: string) => {
        const newName = editingName.trim();
        if (!threadId || !newName) {
            setEditingThreadId(null);
            return;
        }
        setIsSavingRename(true);
        try {
            await threadService.renameThread(threadId, newName);
            setThreads(prev => prev.map(t =>
                t.id === threadId ? { ...t, name: newName } : t
            ));
            // Invalidate caches
            searchCache.clear();
            clearRecentChatsCache();
        } catch (error) {
            console.error('Error renaming thread:', error);
        } finally {
            setEditingThreadId(null);
            setIsSavingRename(false);
        }
    };

    const handleRenameKeyDown = (e: React.KeyboardEvent, threadId: string) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            handleConfirmRename(threadId);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancelRename();
        }
    };

    // Item-filtered mode fetches unscoped and partitions client-side (the
    // deduplicated match set is bounded); unfiltered mode is server-scoped, so
    // no partition is needed there.
    const filteredMismatchCount = useMemo(
        () => filter
            ? threads.filter(t => isThreadInstanceMismatch(instanceRef, {
                zoteroUserId: t.zoteroUserId, zoteroLocalId: t.zoteroLocalId,
            })).length
            : 0,
        [filter, threads, instanceRef]
    );

    const displayedThreads = useMemo(() => {
        let visible = threads;
        if (filter && !showAllInstances) {
            visible = visible.filter(t => !isThreadInstanceMismatch(instanceRef, {
                zoteroUserId: t.zoteroUserId, zoteroLocalId: t.zoteroLocalId,
            }));
        }
        if (filter && activeQuery) {
            visible = visible.filter(t => (t.name || 'Unnamed conversation').toLowerCase().includes(activeQuery.toLowerCase()));
        }
        return visible;
    }, [filter, activeQuery, threads, showAllInstances, instanceRef]);

    // Threads hidden by instance scoping: exact client-side count when
    // item-filtered, the backend-reported count otherwise.
    const hiddenInstanceCount = filter ? filteredMismatchCount : (otherInstanceCount ?? 0);
    // Whether the escape hatch out of instance scoping should be offered.
    const canShowHidden = !isLoading && !showAllInstances && hiddenInstanceCount > 0;
    // Search responses carry no count, so the retained one describes the
    // unfiltered list rather than the current results — drop the number there.
    // Item-filtered mode partitions client-side, so its count is exact.
    const hasExactHiddenCount = !!filter || !activeQuery;
    const hiddenCountSummary = !hasExactHiddenCount
        ? 'Chats from other Zotero profiles are hidden'
        : hiddenInstanceCount === 1
            ? '1 chat from a different Zotero profile is hidden'
            : `${hiddenInstanceCount} chats from other Zotero profiles are hidden`;
    const hiddenExplanation = !hasExactHiddenCount
        ? 'Some of your chats were created in a different Zotero profile. Beaver keeps chat history separate for each one.'
        : hiddenInstanceCount === 1
            ? 'You have 1 chat that was created in a different Zotero profile. Beaver keeps chat history separate for each one.'
            : `You have ${hiddenInstanceCount} chats that were created in a different Zotero profile. Beaver keeps chat history separate for each one.`;

    const groupedThreads = groupThreadsByDate(displayedThreads);

    return (
        <div className="display-flex flex-col flex-1 min-h-0" ref={containerRef}>
            {/* Title */}
            <div className="thread-overlay-title mb-1">Chats</div>

            {/* Search bar */}
            <div className="px-3 pb-2">
                <div className="thread-search-wrapper">
                    <SearchIcon
                        width={14}
                        height={14}
                        className="thread-search-icon"
                    />
                    <input
                        type="text"
                        className="thread-search-input"
                        placeholder="Search chats..."
                        aria-label="Search chats"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        autoFocus
                        ref={searchInputRef}
                    />
                    {isLoading && (
                        <div className="thread-search-spinner">
                            <Spinner size={12} />
                        </div>
                    )}
                </div>
            </div>

            {/* Filter row */}
            <div className="thread-filter-row">
                <ThreadFilterMenu
                    disabled={isLoading}
                    activeFilter={filter}
                    onSelect={handleSelectFilterItem}
                    menuPortalContainer={menuPortalContainer}
                />
                {filter && (
                    <>
                        <div className="thread-filter-divider" />
                        <ChipButton
                            className="thread-filter-chip"
                            onClick={() => {}}
                            aria-label={`Filtered by ${filter.label}`}
                        >
                            <CSSItemTypeIcon itemType={filter.itemType} className="scale-80" />
                            <span className="truncate">{filter.label}</span>
                            <span
                                role="button"
                                aria-label="Remove filter"
                                className="thread-filter-chip-remove"
                                onClick={(e) => { e.stopPropagation(); setFilter(null); focusSearchInput(); }}
                            >
                                <CSSIcon name="x-8" className="icon-16 scale-80" />
                            </span>
                        </ChipButton>
                    </>
                )}
                {/* Active-scope chip mirroring the item-filter chip beside it:
                    it names the current scope, and clicking it (the "x") drops
                    back to this profile. The entry point into "show all" lives
                    in the footer / empty state below the list. */}
                {showAllInstances && (
                    <div className="thread-filter-row-end">
                        <Tooltip
                            content="Showing all Zotero profiles"
                            secondaryContent="Beaver normally shows only chats created with this Zotero profile."
                            width="220px"
                        >
                            <ChipButton
                                onClick={() => toggleShowAllInstances(false)}
                                aria-label="Showing chats from all Zotero profiles. Show only this profile's chats"
                            >
                                <span className="truncate">All profiles</span>
                                <span className="thread-filter-chip-remove" aria-hidden="true">
                                    <CSSIcon name="x-8" className="icon-16 scale-80" />
                                </span>
                            </ChipButton>
                        </Tooltip>
                    </div>
                )}
            </div>
            {filter && !isLoading && (
                <div className="thread-filter-count">
                    Showing {displayedThreads.length} chat{displayedThreads.length === 1 ? '' : 's'} related to {filter.label}
                </div>
            )}

            {/* Thread list */}
            <div className="flex-1 overflow-y-auto px-1">
                {Object.entries(groupedThreads).map(([groupName, groupThreads]) => {
                    if (groupThreads.length === 0) return null;
                    return (
                        <div key={groupName}>
                            <div className="thread-group-header">{groupName}</div>
                            {groupThreads.map(thread => {
                                const threadName = thread.name || 'Unnamed conversation';
                                const isCurrent = thread.id === currentThreadId;
                                const isEditing = editingThreadId === thread.id;
                                const isHovered = hoveredThreadId === thread.id;
                                // Only ever true while showing all instances — the scoped
                                // list contains no foreign threads to label.
                                const isForeign = isThreadInstanceMismatch(instanceRef, {
                                    zoteroUserId: thread.zoteroUserId, zoteroLocalId: thread.zoteroLocalId,
                                });

                                return (
                                    <div
                                        key={thread.id}
                                        className={`thread-list-item ${isEditing ? 'thread-list-item-editing' : ''} ${isHovered ? 'thread-list-item-hovered' : ''}`}
                                        role={isEditing ? undefined : 'button'}
                                        tabIndex={isEditing ? undefined : 0}
                                        aria-label={isEditing ? undefined : `${threadName}, ${formatTimeAgo(thread.updatedAt)}${isCurrent ? ', current chat' : ''}${isForeign ? `, ${FOREIGN_THREAD_TITLE}` : ''}`}
                                        onClick={() => {
                                            if (!isEditing) {
                                                handleSelectThread(thread);
                                            }
                                        }}
                                        onKeyDown={isEditing ? undefined : (e) => {
                                            // Ignore keys bubbling up from nested controls
                                            // (e.g. the Rename/Delete buttons) so they keep
                                            // their own keyboard activation.
                                            if (e.target !== e.currentTarget) return;
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                handleSelectThread(thread);
                                            }
                                        }}
                                        onMouseEnter={() => setHoveredThreadId(thread.id)}
                                        onMouseLeave={() => setHoveredThreadId(null)}
                                    >
                                        <div className="flex-1 min-w-0">
                                            {isEditing ? (
                                                <input
                                                    type="text"
                                                    className="thread-rename-input"
                                                    value={editingName}
                                                    onChange={e => setEditingName(e.target.value)}
                                                    onKeyDown={e => handleRenameKeyDown(e, thread.id)}
                                                    onClick={e => e.stopPropagation()}
                                                    autoFocus
                                                />
                                            ) : (
                                                <div className="thread-list-item-name truncate">
                                                    {activeQuery ? highlightMatch(threadName, activeQuery) : threadName}
                                                </div>
                                            )}
                                            <div className="thread-list-item-time">
                                                {formatTimeAgo(thread.updatedAt)}{isCurrent && ' (current chat)'}
                                                {isForeign && (
                                                    <span className="thread-list-item-badge" title={FOREIGN_THREAD_TITLE}>
                                                        {FOREIGN_THREAD_LABEL}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="thread-list-item-actions">
                                            {isEditing ? (
                                                <div className="display-flex gap-2">
                                                    <IconButton
                                                        icon={CancelIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleCancelRename();
                                                        }}
                                                        className="scale-90"
                                                        ariaLabel="Cancel rename"
                                                    />
                                                    <IconButton
                                                        icon={TickIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleConfirmRename(thread.id);
                                                        }}
                                                        className="scale-11"
                                                        ariaLabel="Confirm rename"
                                                        loading={isSavingRename}
                                                    />
                                                </div>
                                            ) : (
                                                <div className="display-flex gap-3">
                                                    <IconButton
                                                        icon={EditIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleStartRename(thread.id, threadName);
                                                        }}
                                                        className="scale-95"
                                                        ariaLabel="Rename thread"
                                                    />
                                                    <IconButton
                                                        icon={DeleteIcon}
                                                        variant="ghost-secondary"
                                                        onClick={e => {
                                                            e.stopPropagation();
                                                            handleDelete(thread.id);
                                                        }}
                                                        className="scale-95"
                                                        ariaLabel="Delete thread"
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}

                {/* Network error state — replaces empty state when fetch failed transiently */}
                {!isLoading && displayedThreads.length === 0 && fetchError && (
                    <div className="display-flex flex-col items-center justify-center gap-2 py-6 text-center px-3 mt-2">
                        <span className="font-color-primary font-semibold text-sm">
                            {fetchError.offline ? "You're offline" : "Couldn't load chats"}
                        </span>
                        <span className="font-color-tertiary text-sm">
                            {fetchError.offline
                                ? 'Reconnect to load your chats.'
                                : 'Check your connection and try again.'}
                        </span>
                        <Button
                            variant="outline"
                            onClick={() => fetchThreads(activeQuery)}
                            disabled={isLoading}
                            type="button"
                            loading={isLoading}
                        >
                            Try again
                        </Button>
                    </div>
                )}

                {/* Empty state — prominent variant. With nothing else on screen
                    the hidden chats are the whole story, so they get the full
                    explanation plus the escape hatch instead of a footer note. */}
                {!isLoading && displayedThreads.length === 0 && !fetchError && canShowHidden && (
                    <div className="display-flex flex-col items-center justify-center gap-3 py-6 text-center px-3 mt-2">
                        <span className="font-color-primary font-semibold text-base">
                            {activeQuery ? 'No matching chats' : filter ? `No chats about ${filter.label}` : 'No chats on this Zotero profile'}
                        </span>
                        <span className="font-color-secondary text-base">
                            {hiddenExplanation}
                        </span>
                        <Button
                            variant="outline"
                            onClick={() => toggleShowAllInstances(true)}
                            type="button"
                            className="mt-2"
                        >
                            Show all chats
                        </Button>
                    </div>
                )}

                {/* Empty state */}
                {!isLoading && displayedThreads.length === 0 && !fetchError && !canShowHidden && (
                    <div className="display-flex items-center justify-center py-6">
                        <span className="font-color-tertiary text-sm">
                            {activeQuery ? 'No matching chats' : filter ? `No chats about ${filter.label}` : 'No chats yet'}
                        </span>
                    </div>
                )}

                {/* Loading spinner */}
                {isLoading && displayedThreads.length === 0 && (
                    <div className="display-flex items-center justify-center py-6">
                        <Spinner size={18} />
                    </div>
                )}

                {/* Inline network error — when we already have some threads but a refresh / load-more failed */}
                {displayedThreads.length > 0 && fetchError && !isLoading && (
                    <div className="display-flex items-center gap-2 px-3 py-2">
                        <span className="font-color-tertiary text-sm flex-1">
                            {fetchError.offline ? "You're offline." : "Couldn't reach the server."}
                        </span>
                        <Button
                            variant="outline"
                            onClick={() => fetchThreads(activeQuery)}
                            disabled={isLoading}
                            type="button"
                        >
                            Try again
                        </Button>
                    </div>
                )}

                {/* Show more */}
                {hasMore && !fetchError && (
                    <div className="display-flex justify-start p-2 ml-2 pb-3">
                        <Button
                            variant="outline"
                            onClick={loadMoreThreads}
                            disabled={isLoading}
                            type="button"
                            loading={isLoading}
                        >
                            Show more
                        </Button>
                    </div>
                )}
            </div>

            {/* Footer: instance-scoping escape hatch. Outside the scroll area so
                it stays visible, and only while the list has rows — an empty
                list gets the prominent variant above instead. */}
            {canShowHidden && displayedThreads.length > 0 && (
                <div className="thread-filter-footer-note">
                    {hiddenCountSummary}
                    {' · '}
                    <span
                        role="button"
                        tabIndex={0}
                        className="font-color-accent-blue cursor-pointer"
                        onClick={() => toggleShowAllInstances(true)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleShowAllInstances(true); } }}
                    >
                        Show all
                    </span>
                </div>
            )}
        </div>
    );
};

export default ThreadListView;
