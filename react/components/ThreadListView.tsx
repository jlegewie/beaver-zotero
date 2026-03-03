import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ArrowLeftIcon, SearchIcon, EditIcon, DeleteIcon, PlusSignIcon, TickIcon, CancelIcon } from './icons/icons';
import Spinner from './icons/Spinner';
import IconButton from './ui/IconButton';
import { isThreadListViewAtom } from '../atoms/ui';
import { ThreadData, loadThreadAtom, newThreadAtom } from '../atoms/threads';
import { currentThreadIdAtom } from '../agents/atoms';
import { userAtom } from '../atoms/auth';
import { threadService } from '../../src/services/threadService';
import { getPref } from '../../src/utils/prefs';
import { getDateGroup } from '../utils/dateUtils';
import { formatTimeAgo } from '../utils/formatTimeAgo';

interface ThreadListViewProps {
    isWindow?: boolean;
}

interface CacheEntry {
    threads: ThreadData[];
    hasMore: boolean;
    nextCursor: string | null;
    offset: number;
}

const PAGE_SIZE = 15;

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

    const [threads, setThreads] = useState<ThreadData[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [offset, setOffset] = useState(0);

    const [searchQuery, setSearchQuery] = useState('');
    const [activeQuery, setActiveQuery] = useState('');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchCacheRef = useRef<Map<string, CacheEntry>>(new Map());

    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [isSavingRename, setIsSavingRename] = useState(false);
    const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);

    const statefulChat = getPref('statefulChat');

    // Fetch threads (initial load or after search)
    const fetchThreads = useCallback(async (query: string) => {
        if (!user) return;

        // Check cache
        const cached = searchCacheRef.current.get(query);
        if (cached) {
            setThreads(cached.threads);
            setHasMore(cached.hasMore);
            setNextCursor(cached.nextCursor);
            setOffset(cached.offset);
            return;
        }

        setIsLoading(true);
        try {
            if (query) {
                // Search mode
                if (statefulChat) {
                    const response = await threadService.searchThreads(query, PAGE_SIZE);
                    const mapped = response.data.map(t => ({
                        id: t.id,
                        name: t.name || '',
                        createdAt: t.created_at,
                        updatedAt: t.updated_at,
                    } as ThreadData));
                    setThreads(mapped);
                    setNextCursor(response.next_cursor);
                    setHasMore(response.has_more);
                    setOffset(0);
                    searchCacheRef.current.set(query, {
                        threads: mapped,
                        hasMore: response.has_more,
                        nextCursor: response.next_cursor,
                        offset: 0,
                    });
                } else {
                    // Local DB: fetch all and filter client-side
                    const response = await Zotero.Beaver.db.getThreadsPaginated(user.id, 200, 0);
                    const lowerQuery = query.toLowerCase();
                    const filtered = response.threads.filter(t =>
                        (t.name || '').toLowerCase().includes(lowerQuery)
                    );
                    setThreads(filtered);
                    setHasMore(false);
                    setNextCursor(null);
                    setOffset(0);
                    searchCacheRef.current.set(query, {
                        threads: filtered,
                        hasMore: false,
                        nextCursor: null,
                        offset: 0,
                    });
                }
            } else {
                // Normal paginated fetch
                if (statefulChat) {
                    const response = await threadService.getPaginatedThreads(PAGE_SIZE);
                    const mapped = response.data.map(t => ({
                        id: t.id,
                        name: t.name || '',
                        createdAt: t.created_at,
                        updatedAt: t.updated_at,
                    } as ThreadData));
                    setThreads(mapped);
                    setNextCursor(response.next_cursor);
                    setHasMore(response.has_more);
                    setOffset(0);
                    searchCacheRef.current.set('', {
                        threads: mapped,
                        hasMore: response.has_more,
                        nextCursor: response.next_cursor,
                        offset: 0,
                    });
                } else {
                    const response = await Zotero.Beaver.db.getThreadsPaginated(user.id, PAGE_SIZE, 0);
                    setThreads(response.threads);
                    setHasMore(response.has_more);
                    setNextCursor(null);
                    setOffset(PAGE_SIZE);
                    searchCacheRef.current.set('', {
                        threads: response.threads,
                        hasMore: response.has_more,
                        nextCursor: null,
                        offset: PAGE_SIZE,
                    });
                }
            }
        } catch (error) {
            console.error('Error fetching threads:', error);
        } finally {
            setIsLoading(false);
        }
    }, [user, statefulChat]);

    // Initial fetch
    useEffect(() => {
        fetchThreads('');
    }, [fetchThreads]);

    // Debounced search
    useEffect(() => {
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
        }
        if (searchQuery === activeQuery) return;

        debounceRef.current = setTimeout(() => {
            setActiveQuery(searchQuery);
            fetchThreads(searchQuery);
        }, 400);

        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
        };
    }, [searchQuery, activeQuery, fetchThreads]);

    const handleSearchKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
            }
            setActiveQuery(searchQuery);
            // Invalidate cache for this query to get fresh results on Enter
            searchCacheRef.current.delete(searchQuery);
            fetchThreads(searchQuery);
        }
    };

    // Load more
    const loadMoreThreads = async () => {
        if (!user || isLoading) return;

        setIsLoading(true);
        try {
            if (activeQuery && statefulChat) {
                const response = await threadService.searchThreads(activeQuery, PAGE_SIZE, nextCursor);
                const mapped = response.data.map(t => ({
                    id: t.id,
                    name: t.name || '',
                    createdAt: t.created_at,
                    updatedAt: t.updated_at,
                } as ThreadData));
                const combined = [...threads, ...mapped];
                setThreads(combined);
                setNextCursor(response.next_cursor);
                setHasMore(response.has_more);
                searchCacheRef.current.set(activeQuery, {
                    threads: combined,
                    hasMore: response.has_more,
                    nextCursor: response.next_cursor,
                    offset: 0,
                });
            } else if (!activeQuery) {
                if (statefulChat) {
                    const response = await threadService.getPaginatedThreads(PAGE_SIZE, nextCursor);
                    const mapped = response.data.map(t => ({
                        id: t.id,
                        name: t.name || '',
                        createdAt: t.created_at,
                        updatedAt: t.updated_at,
                    } as ThreadData));
                    const combined = [...threads, ...mapped];
                    setThreads(combined);
                    setNextCursor(response.next_cursor);
                    setHasMore(response.has_more);
                    searchCacheRef.current.set('', {
                        threads: combined,
                        hasMore: response.has_more,
                        nextCursor: response.next_cursor,
                        offset: 0,
                    });
                } else {
                    const response = await Zotero.Beaver.db.getThreadsPaginated(user.id, PAGE_SIZE, offset);
                    const combined = [...threads, ...response.threads];
                    const newOffset = offset + PAGE_SIZE;
                    setThreads(combined);
                    setHasMore(response.has_more);
                    setOffset(newOffset);
                    searchCacheRef.current.set('', {
                        threads: combined,
                        hasMore: response.has_more,
                        nextCursor: null,
                        offset: newOffset,
                    });
                }
            }
        } catch (error) {
            console.error('Error loading more threads:', error);
        } finally {
            setIsLoading(false);
        }
    };

    // Thread actions
    const handleSelectThread = async (threadId: string, threadName?: string) => {
        if (!user) return;
        try {
            await loadThread({ user_id: user.id, threadId, threadName });
            setIsThreadListView(false);
        } catch (error) {
            console.error('Error loading thread:', error);
        }
    };

    const handleNewChat = async () => {
        await newThread();
        setIsThreadListView(false);
    };

    const handleBack = () => {
        setIsThreadListView(false);
    };

    const handleDelete = async (threadId: string) => {
        try {
            if (statefulChat) {
                await threadService.deleteThread(threadId);
            } else if (user) {
                await Zotero.Beaver.db.deleteThread(user.id, threadId);
            }
            setThreads(prev => prev.filter(t => t.id !== threadId));
            // Invalidate cache
            searchCacheRef.current.clear();
            // If deleting the current thread, create a new one
            if (threadId === currentThreadId) {
                await newThread();
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
            if (statefulChat) {
                await threadService.renameThread(threadId, newName);
            } else if (user) {
                await Zotero.Beaver.db.renameThread(user.id, threadId, newName);
            }
            setThreads(prev => prev.map(t =>
                t.id === threadId ? { ...t, name: newName } : t
            ));
            // Invalidate cache
            searchCacheRef.current.clear();
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

    const groupedThreads = groupThreadsByDate(threads);

    return (
        <div className="display-flex flex-col flex-1 min-h-0">
            {/* Sub-header */}
            <div className="thread-list-header">
                <div className="display-flex items-center gap-2">
                    <IconButton
                        icon={ArrowLeftIcon}
                        onClick={handleBack}
                        className="scale-14"
                        ariaLabel="Back to chat"
                    />
                    <span className="font-bold font-color-primary">Chats</span>
                </div>
                <button
                    className="variant-outline has-text scale-85"
                    onClick={handleNewChat}
                    type="button"
                >
                    <span className="display-flex items-center gap-1">
                        <PlusSignIcon width={12} height={12} />
                        New chat
                    </span>
                </button>
            </div>

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
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        autoFocus
                    />
                </div>
            </div>

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

                                return (
                                    <div
                                        key={thread.id}
                                        className={`thread-list-item ${isCurrent ? 'thread-list-item-active' : ''} ${isEditing ? 'thread-list-item-editing' : ''} ${isHovered ? 'thread-list-item-hovered' : ''}`}
                                        onClick={() => {
                                            if (!isEditing) {
                                                handleSelectThread(thread.id, thread.name);
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
                                                    {threadName}
                                                </div>
                                            )}
                                            <div className="thread-list-item-time">
                                                {formatTimeAgo(thread.updatedAt)}
                                            </div>
                                        </div>
                                        <div className="thread-list-item-actions">
                                            {isEditing ? (
                                                <div className="display-flex gap-3">
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
                                                        // className="scale-95"
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

                {/* Empty state */}
                {!isLoading && threads.length === 0 && (
                    <div className="display-flex items-center justify-center py-6">
                        <span className="font-color-tertiary text-sm">
                            {activeQuery ? 'No matching chats' : 'No chats yet'}
                        </span>
                    </div>
                )}

                {/* Loading spinner */}
                {isLoading && threads.length === 0 && (
                    <div className="display-flex items-center justify-center py-6">
                        <Spinner size={18} />
                    </div>
                )}

                {/* Show more */}
                {hasMore && (
                    <div className="display-flex justify-center py-2 pb-3">
                        <button
                            className="variant-outline has-text scale-85 display-flex items-center justify-center"
                            onClick={loadMoreThreads}
                            disabled={isLoading}
                            type="button"
                        >
                            {isLoading ? <Spinner size={12} className="mr-1" /> : 'Show more'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ThreadListView;
