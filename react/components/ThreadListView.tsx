import ChatLoadFailure from './ChatLoadFailure';
import React, { useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { SearchIcon, EditIcon, DeleteIcon, TickIcon, CancelIcon, PinIcon, PinOffIcon } from './icons/icons';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { isThreadListViewAtom, threadListFilterAtom, showAllThreadInstancesAtom } from '../atoms/ui';
import { ThreadData } from '../atoms/threads';
import { threadViewsAtom, threadViewKey } from '../atoms/threadList';
import { userAtom } from '../atoms/auth';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { formatTimeAgo } from '../utils/formatTimeAgo';
import { buildThreadItemFilter } from '../utils/threadItemFilter';
import { highlightMatch } from '../utils/highlightMatch';
import { useThreadHistory } from '../hooks/useThreadHistory';
import { useThreadHistoryScroll } from '../hooks/useThreadHistoryScroll';
import { isThreadInstanceMismatch } from '../../src/services/threads/threadMatches';
import Button from '@beaver/agent-ui/primitives/Button';
import { ChipButton } from './agentRuns/requestChips/ChipButton';
import { CSSIcon, CSSItemTypeIcon } from './icons/zotero';
import ThreadFilterMenu from './ui/menus/ThreadFilterMenu';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';

interface ThreadListViewProps {
    isWindow?: boolean;
}

// Marks a chat created in a different Zotero install. Always says "Zotero" —
// a bare "account" would read as the user's Beaver account, which never
// differs here. A mismatch always implies a different profile (see
// `isThreadInstanceMismatch`), so one label covers every case.
const FOREIGN_THREAD_LABEL = 'Other Zotero profile';
const FOREIGN_THREAD_TITLE = 'Created in a different Zotero account or profile';

const ThreadListView: React.FC<ThreadListViewProps> = ({ isWindow: _isWindow }) => {
    const setIsThreadListView = useSetAtom(isThreadListViewAtom);
    const user = useAtomValue(userAtom);
    const filter = useAtomValue(threadListFilterAtom);
    const setFilter = useSetAtom(threadListFilterAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const views = useAtomValue(threadViewsAtom);

    // Instance scoping: hide threads stamped by other Zotero accounts/installs
    // by default; "Show all" reveals them. Global so the choice survives closing
    // and reopening the thread list.
    const showAllInstances = useAtomValue(showAllThreadInstancesAtom);
    const setShowAllInstances = useSetAtom(showAllThreadInstancesAtom);

    const clearFilter = useCallback(() => setFilter(null), [setFilter]);
    const history = useThreadHistory({ filter, onFilterUnavailable: clearFilter });
    const { scrollRef, sentinelRef } = useThreadHistoryScroll(history);
    const {
        activeQuery,
        isLoading,
        view,
        instanceRef,
        rows,
        visibleRows,
        pinnedThreads,
        groups,
        currentThreadId,
    } = history;
    const fetchError = view.error;

    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [isSavingRename, setIsSavingRename] = useState(false);
    const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const menuPortalContainer = containerRef.current?.closest('[id^="beaver-react-root-"], #beaver-pane-window') as HTMLElement | null;
    const searchInputRef = useRef<HTMLInputElement | null>(null);

    // Last known pointer position inside this list, so hover can be re-resolved
    // without a mouse move. Pinning, unpinning or deleting reorders the rows
    // under a stationary cursor and no mouseenter follows, which would
    // otherwise leave the row now under the pointer without its hover actions.
    const pointerRef = useRef<{ x: number; y: number } | null>(null);

    /** Points `hoveredThreadId` at whatever row currently sits under the pointer. */
    const syncHoverToPointer = useCallback(() => {
        const pointer = pointerRef.current;
        const container = containerRef.current;
        if (!pointer || !container) return;
        const target = container.ownerDocument?.elementFromPoint(pointer.x, pointer.y) as HTMLElement | null;
        const row = target?.closest('.thread-list-item') as HTMLElement | null;
        // Both sidebars can render this list into one document, so ignore a row
        // that belongs to the other one.
        const threadId = row && container.contains(row) ? (row.dataset.threadId ?? null) : null;
        setHoveredThreadId(prev => (prev === threadId ? prev : threadId));
    }, []);

    // The filter menu's own search input holds focus while the menu is open
    // and nothing restores it on close, so refocus after the close settles.
    const focusSearchInput = () => {
        setTimeout(() => searchInputRef.current?.focus(), 5);
    };

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsThreadListView(false);
            return;
        }
        if (e.key === 'Enter') {
            history.submitSearch();
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
        // Keep the list open when the load was aborted (e.g. the user
        // canceled the other-instance confirm) or failed.
        if (await history.selectThread(thread)) setIsThreadListView(false);
    };

    const handleStartRename = (threadId: string, currentName: string) => {
        setEditingThreadId(threadId);
        setEditingName(currentName || 'Unnamed conversation');
    };

    const handleCancelRename = () => {
        setEditingThreadId(null);
    };

    const handleConfirmRename = async (threadId: string) => {
        setIsSavingRename(true);
        try {
            await history.renameThread(threadId, editingName);
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

    // Item-filtered mode partitions client-side, so its hidden count is exact.
    const filteredMismatchCount = useMemo(
        () => filter
            ? rows.filter(t => isThreadInstanceMismatch(instanceRef, {
                zoteroUserId: t.zoteroUserId, zoteroLocalId: t.zoteroLocalId,
            })).length
            : 0,
        [filter, rows, instanceRef]
    );

    const displayedCount = groups.reduce((n, group) => n + group.threads.length, 0);
    const hasVisibleRows = visibleRows.length > 0;

    // The rendered order, as a value that only changes when a row is added,
    // removed or moved — the moments a stationary pointer lands on a new row.
    const rowOrderKey = useMemo(
        () => `${pinnedThreads.map(t => t.id).join(',')}|${groups.map(g => g.threads.map(t => t.id).join(',')).join(',')}`,
        [pinnedThreads, groups]
    );
    useLayoutEffect(() => {
        syncHoverToPointer();
    }, [rowOrderKey, syncHoverToPointer]);

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
        const pinPending = history.isPinPending(thread.id);

        return (
            <div
                key={thread.id}
                data-thread-id={thread.id}
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
                            {highlightMatch(threadName, activeQuery)}
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
                                className="scale-12"
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
                                    history.togglePin(thread);
                                }}
                                className="scale-11"
                                ariaLabel={thread.isPinned ? 'Unpin chat' : 'Pin chat'}
                                loading={pinPending}
                            />
                            <IconButton
                                icon={EditIcon}
                                variant="ghost-secondary"
                                onClick={e => {
                                    e.stopPropagation();
                                    handleStartRename(thread.id, threadName);
                                }}
                                className="scale-11"
                                ariaLabel="Rename thread"
                            />
                            <IconButton
                                icon={DeleteIcon}
                                variant="ghost-secondary"
                                onClick={e => {
                                    e.stopPropagation();
                                    void history.deleteThread(thread.id);
                                }}
                                className="scale-11"
                                ariaLabel="Delete thread"
                            />
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div
            className="display-flex flex-col flex-1 min-h-0"
            ref={containerRef}
            onMouseMove={e => { pointerRef.current = { x: e.clientX, y: e.clientY }; }}
            onMouseLeave={() => { pointerRef.current = null; }}
        >
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
                        value={history.searchQuery}
                        onChange={e => history.setSearchQuery(e.target.value)}
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
                    Showing {displayedCount} chat{displayedCount === 1 ? '' : 's'} related to {filter.label}
                </div>
            )}

            {/* Thread list */}
            <div className="flex-1 min-h-0 overflow-y-auto px-1" ref={scrollRef}>
                {pinnedThreads.length > 0 && (
                    <div>
                        <div className="thread-group-header">Pinned</div>
                        {pinnedThreads.map(renderThreadRow)}
                    </div>
                )}
                {groups.map(group => (
                    <div key={group.label}>
                        <div className="thread-group-header">{group.label}</div>
                        {group.threads.map(renderThreadRow)}
                    </div>
                ))}
                {!isLoading && fetchError && (
                    <ChatLoadFailure error={fetchError} retry={history.reload} />
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

                <div ref={sentinelRef} style={{ minHeight: view.hasMore ? 32 : 1 }}>
                    {isLoading && hasVisibleRows && (
                        <div className="display-flex items-center justify-center py-2" role="status" aria-label="Loading more chats">
                            <Spinner size={16} />
                        </div>
                    )}
                </div>
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
