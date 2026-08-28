import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { SearchIcon, EditIcon, DeleteIcon, TickIcon, CancelIcon, PinIcon, PinOffIcon } from './icons/icons';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { isThreadListViewAtom, threadListFilterAtom, showAllThreadInstancesAtom } from '../atoms/ui';
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
    loadThreadsByItemAtom,
    setThreadPinnedAtom,
    pinsPendingAtom,
    isPinPending,
    updateThreadAtom,
    removeThreadAtom,
    EMPTY_THREAD_VIEW,
} from '../atoms/threadList';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { userAtom } from '../atoms/auth';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { threadService } from '@beaver/agent-core/transport/threadService';
import { currentZoteroInstanceRef } from '../../src/utils/zoteroUtils';
import { getDateGroup } from '../utils/dateUtils';
import { formatTimeAgo } from '../utils/formatTimeAgo';
import { buildThreadItemFilter } from '../utils/threadItemFilter';
import { isThreadInstanceMismatch } from '../utils/threadMatches';
import Button from '@beaver/agent-ui/primitives/Button';
import { ChipButton } from './agentRuns/requestChips/ChipButton';
import { CSSIcon, CSSItemTypeIcon } from './icons/zotero';
import ThreadFilterMenu from './ui/menus/ThreadFilterMenu';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { clearRecentChatsCache } from './RecentChats';

interface ThreadListViewProps {
    isWindow?: boolean;
}

// Marks a chat created in a different Zotero install. Always says "Zotero" —
// a bare "account" would read as the user's Beaver account, which never
// differs here. A mismatch always implies a different profile (see
// `isThreadInstanceMismatch`), so one label covers every case.
const FOREIGN_THREAD_LABEL = 'Other Zotero profile';
const FOREIGN_THREAD_TITLE = 'Created in a different Zotero account or profile';

/** Stable identity for "no rows", so the memos below are not invalidated per render. */
const EMPTY_THREADS: ThreadData[] = [];

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

    // The normalized store. Every surface renders from these two, which is what
    // keeps this list, the separate window's list and the header menu in step
    // without any of them notifying the others.
    const entities = useAtomValue(threadEntitiesAtom);
    const views = useAtomValue(threadViewsAtom);
    const loadPage = useSetAtom(loadThreadPageAtom);
    const loadMore = useSetAtom(loadMoreThreadsAtom);
    const loadPinned = useSetAtom(loadPinnedThreadsAtom);
    const loadByItem = useSetAtom(loadThreadsByItemAtom);
    const setThreadPinned = useSetAtom(setThreadPinnedAtom);
    const pinsPending = useAtomValue(pinsPendingAtom);
    const updateThread = useSetAtom(updateThreadAtom);
    const removeThread = useSetAtom(removeThreadAtom);

    // Instance scoping: hide threads stamped by other Zotero accounts/installs
    // by default; "Show all" reveals them. Global so the choice survives closing
    // and reopening the thread list.
    const showAllInstances = useAtomValue(showAllThreadInstancesAtom);
    const setShowAllInstances = useSetAtom(showAllThreadInstancesAtom);

    const [searchQuery, setSearchQuery] = useState('');
    const [activeQuery, setActiveQuery] = useState('');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Read live — the Zotero account id can appear or disappear when the user
    // logs in or out without this component remounting. Memoized on its values
    // because the helper returns a fresh object each call.
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


    // Which view this render is showing. Search, item filter and instance scope
    // each produce a different one, so a response can only ever land in the view
    // that asked for it.
    const viewKey = useMemo(
        () => (user
            ? threadViewKey({ userId: user.id, query: filter ? '' : activeQuery, showAll: showAllInstances, scope: instanceRef, filter })
            : ''),
        [user, activeQuery, showAllInstances, instanceRef, filter]
    );
    const view = views.get(viewKey) ?? EMPTY_THREAD_VIEW;

    const isLoading = view.status === 'loading';
    const fetchError = view.error;

    // Load this view. Item-filtered mode answers a different question, so it
    // uses its own loader; both merge into the same entity store.
    useEffect(() => {
        if (!user) return;
        if (filter) {
            // Exclusions can change (Beaver Preferences) while the view is open,
            // so re-check at load time instead of trusting a stale atom.
            if (!searchableLibraryIds.includes(filter.libraryId)) {
                setFilter(null);
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
    }, [user, viewKey, filter, activeQuery, scope, searchableLibraryIds, loadPage, loadByItem, setFilter]);

    // Pinned chats reach further back than the paginated window, so they are a
    // second discovery query into the same view. Only the plain list shows the
    // group, so only it needs them.
    const showPinnedGroup = !activeQuery && !filter;
    useEffect(() => {
        if (!user || !showPinnedGroup) return;
        loadPinned({ key: viewKey, scope });
    }, [user, showPinnedGroup, viewKey, scope, loadPinned]);

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
    const reloadView = useCallback(() => {
        if (!user) return;
        if (filter) {
            loadByItem({ key: viewKey, filter, force: true });
            return;
        }
        loadPage({ key: viewKey, query: activeQuery, scope, includeOtherCount: scope !== undefined, force: true });
        if (showPinnedGroup) loadPinned({ key: viewKey, scope, force: true });
    }, [user, filter, viewKey, activeQuery, scope, showPinnedGroup, loadPage, loadByItem, loadPinned]);

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsThreadListView(false);
            return;
        }
        if (e.key === 'Enter') {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (searchQuery !== activeQuery) {
                setActiveQuery(searchQuery);
            } else {
                // Already showing this query — Enter asks for fresh results.
                reloadView();
            }
        }
    };

    const handleSelectFilterItem = async (item: Zotero.Item) => {
        const f = await buildThreadItemFilter(item, searchableLibraryIds);
        if (f) setFilter(f);
        focusSearchInput();
    };

    const toggleShowAllInstances = (next: boolean) => {
        setShowAllInstances(next);
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

    /**
     * Pins or unpins a chat. The store owns the optimistic write, its rollback
     * and the one-toggle-at-a-time guard, so this is just the call.
     */
    const handleTogglePin = (thread: ThreadData) => {
        void setThreadPinned({ threadId: thread.id, pinned: !thread.isPinned, viewKey });
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
            clearRecentChatsCache(threadId);
            // Switch away first when this is the open chat: forgetting the
            // entity while it is still `currentThreadId` makes the header's pin
            // state read "unknown" and fire a GET for a chat that is gone.
            // The user already confirmed the delete, so skip the run confirm.
            if (threadId === currentThreadId) {
                await newThread({ skipActiveRunConfirm: true });
            }
            // One removal: every view resolves ids through the entity map and
            // drops what it cannot find, so no id set needs touching.
            removeThread(threadId);
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
            updateThread({ id: threadId, update: t => ({ ...t, name: newName }) });
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

    // ---- Derivations -------------------------------------------------------

    /** The view's rows, newest first, with dead ids dropped. */
    const rows = useMemo(() => resolveThreadView(view, entities), [view, entities]);

    // Item-filtered mode fetches unscoped and partitions client-side (the
    // deduplicated match set is bounded); the other modes are server-scoped.
    const filteredMismatchCount = useMemo(
        () => filter
            ? rows.filter(t => isThreadInstanceMismatch(instanceRef, {
                zoteroUserId: t.zoteroUserId, zoteroLocalId: t.zoteroLocalId,
            })).length
            : 0,
        [filter, rows, instanceRef]
    );

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
    // window: pinning from a search or from the header menu must show up here
    // even when the paginated query has not reached that chat. The date groups
    // below are the window minus whatever the group took, so a chat still
    // cannot render twice. A search shows only its results, and an item filter
    // answers "chats about X", so neither shows the group.
    const pinnedThreads = useMemo(
        () => (showPinnedGroup ? selectPinnedThreads(entities, scope) : EMPTY_THREADS),
        [showPinnedGroup, entities, scope]
    );
    const displayedThreads = useMemo(
        () => (showPinnedGroup ? visibleRows.filter(t => !t.isPinned) : visibleRows),
        [showPinnedGroup, visibleRows]
    );
    const hasVisibleRows = visibleRows.length > 0;

    // Threads hidden by instance scoping: exact client-side count when
    // item-filtered, the backend-reported count otherwise. Only a scoped first
    // page carries one, so a search view never has its own — fall back to the
    // plain view's, which is what the escape hatch below is about anyway.
    const baseViewKey = useMemo(
        () => (user ? threadViewKey({ userId: user.id, showAll: showAllInstances, scope: instanceRef }) : ''),
        [user, showAllInstances, instanceRef]
    );
    const reportedOtherCount = view.otherInstanceCount ?? views.get(baseViewKey)?.otherInstanceCount ?? 0;
    const hiddenInstanceCount = filter ? filteredMismatchCount : reportedOtherCount;
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

    /**
     * One chat row. Shared by the pinned group and the date groups so both
     * carry the same hover actions, rename mode and foreign-profile badge.
     */
    const renderThreadRow = (thread: ThreadData) => {
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
                aria-label={isEditing ? undefined : `${threadName}, ${formatTimeAgo(thread.updatedAt)}${isCurrent ? ', current chat' : ''}${thread.isPinned ? ', pinned' : ''}${isForeign ? `, ${FOREIGN_THREAD_TITLE}` : ''}`}
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
                                icon={thread.isPinned ? PinOffIcon : PinIcon}
                                variant="ghost-secondary"
                                onClick={e => {
                                    e.stopPropagation();
                                    handleTogglePin(thread);
                                }}
                                className="scale-95"
                                ariaLabel={thread.isPinned ? 'Unpin chat' : 'Pin chat'}
                                disabled={isPinPending(pinsPending, thread.id)}
                            />
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
    };

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
                {pinnedThreads.length > 0 && (
                    <div>
                        <div className="thread-group-header">Pinned</div>
                        {pinnedThreads.map(renderThreadRow)}
                    </div>
                )}
                {Object.entries(groupedThreads).map(([groupName, groupThreads]) => {
                    if (groupThreads.length === 0) return null;
                    return (
                        <div key={groupName}>
                            <div className="thread-group-header">{groupName}</div>
                            {groupThreads.map(renderThreadRow)}
                        </div>
                    );
                })}
                {/* Network error state — replaces empty state when fetch failed transiently */}
                {!isLoading && !hasVisibleRows && fetchError && (
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
                            onClick={reloadView}
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
                {!isLoading && !hasVisibleRows && !fetchError && canShowHidden && (
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
                {!isLoading && !hasVisibleRows && !fetchError && !canShowHidden && (
                    <div className="display-flex items-center justify-center py-6">
                        <span className="font-color-tertiary text-sm">
                            {activeQuery ? 'No matching chats' : filter ? `No chats about ${filter.label}` : 'No chats yet'}
                        </span>
                    </div>
                )}

                {/* Loading spinner */}
                {isLoading && !hasVisibleRows && (
                    <div className="display-flex items-center justify-center py-6">
                        <Spinner size={18} />
                    </div>
                )}

                {/* Inline network error — when we already have some threads but a refresh / load-more failed */}
                {hasVisibleRows && fetchError && !isLoading && (
                    <div className="display-flex items-center gap-2 px-3 py-2">
                        <span className="font-color-tertiary text-sm flex-1">
                            {fetchError.offline ? "You're offline." : "Couldn't reach the server."}
                        </span>
                        <Button
                            variant="outline"
                            onClick={reloadView}
                            disabled={isLoading}
                            type="button"
                        >
                            Try again
                        </Button>
                    </div>
                )}

                {/* Show more */}
                {view.hasMore && !fetchError && (
                    <div className="display-flex justify-start p-2 ml-2 pb-3">
                        <Button
                            variant="outline"
                            onClick={() => loadMore({ key: viewKey, query: activeQuery, scope })}
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
            {canShowHidden && hasVisibleRows && (
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
