import ChatLoadFailure from './ChatLoadFailure';
import { useChatReconnect } from '../hooks/useChatReconnect';
import { useSurfaceWindow } from '../runtime/SurfaceWindowContext';
import React, { useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { isThreadListViewAtom, isLibraryTabAtom, selectedZoteroTabIdAtom, hasPopupMessagesAtom, threadListFilterAtom, ThreadItemFilter } from '../atoms/ui';
import { ThreadData, loadThreadAtom } from '../atoms/threads';
import { threadEntitiesAtom, threadViewsAtom, threadViewKey, EMPTY_THREAD_VIEW, resolveThreadView, loadThreadPageAtom, loadThreadsByItemAtom } from '../atoms/threadList';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { convertUTCToLocal } from '../utils/dateUtils';
import { isThreadInstanceMismatch } from '../../src/services/threads/threadMatches';
import { currentZoteroInstanceRef } from '../../src/utils/zoteroUtils';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { getReaderOrNoteContextItem } from '../utils/zoteroTabContext';
import { buildThreadItemFilter } from '../utils/threadItemFilter';
import { buildRecentChatsItemLookup } from '../utils/recentChatsLookup';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import Button from '@beaver/agent-ui/primitives/Button';

const MAX_RECENT = 3;
type ContextType = 'recent' | 'file' | 'note';

/**
 * Compact relative time: "now", "3m", "2h", "1d", "2w", "3mo"
 */
function formatCompactTime(utcDateString: string): string {
    const localDate = convertUTCToLocal(utcDateString);
    const diffMs = Date.now() - localDate.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);
    const diffWeeks = Math.floor(diffDays / 7);

    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    if (diffWeeks < 5) return `${diffWeeks}w`;
    return `${Math.floor(diffDays / 30)}mo`;
}

const RecentChats: React.FC = () => {
    const surfaceWindow = useSurfaceWindow();
    const user = useAtomValue(userAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const selectedTabId = useAtomValue(selectedZoteroTabIdAtom);
    const setIsThreadListView = useSetAtom(isThreadListViewAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const setFilter = useSetAtom(threadListFilterAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const hasPopupMessages = useAtomValue(hasPopupMessagesAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const entities = useAtomValue(threadEntitiesAtom);
    const views = useAtomValue(threadViewsAtom);
    const loadPage = useSetAtom(loadThreadPageAtom);
    const loadByItem = useSetAtom(loadThreadsByItemAtom);
    const { ctx, filter } = useMemo(() => {
        const ctx = !isLibraryTab && selectedTabId ? getReaderOrNoteContextItem(selectedTabId) : null;
        const lookup = ctx ? buildRecentChatsItemLookup(ctx.libraryId, ctx.keys, searchableLibraryIds) : null;
        const filter: ThreadItemFilter | null = lookup ? {
            libraryId: lookup.libraryId, libraryRef: libraryRefForLibraryID(lookup.libraryId) ?? undefined,
            keys: lookup.zoteroKeys, itemKey: ctx!.item.key, itemType: '', label: '',
        } : null;
        return { ctx, filter };
    }, [isLibraryTab, selectedTabId, searchableLibraryIds]);
    const instance = currentZoteroInstanceRef();
    const scope = useMemo(() => instance ?? undefined, [instance?.zoteroUserId, instance?.zoteroLocalId]);
    const pageKey = threadViewKey({ userId: user?.id ?? '', showAll: false, scope });
    const itemKey = filter ? threadViewKey({ userId: user?.id ?? '', showAll: false, filter }) : null;
    const itemView = itemKey ? views.get(itemKey) ?? EMPTY_THREAD_VIEW : EMPTY_THREAD_VIEW;
    const itemRows = resolveThreadView(itemView, entities).filter(thread => !isThreadInstanceMismatch(scope ?? null, thread));
    const useItems = !!itemKey && (itemView.status !== 'ready' || itemRows.length > 0);
    const activeView = useItems ? itemView : views.get(pageKey) ?? EMPTY_THREAD_VIEW;
    const threads = (useItems ? itemRows : resolveThreadView(activeView, entities)).slice(0, MAX_RECENT);
    const contextType: ContextType = useItems ? ctx?.source === 'reader' ? 'file' : 'note' : 'recent';
    const fetchError = activeView.error;
    const isLoaded = activeView.status === 'ready' || activeView.status === 'error';
    const isFetching = activeView.status === 'loading';
    const retry = () => {
        if (useItems && filter && itemKey) void loadByItem({ key: itemKey, filter, force: true });
        else void loadPage({ key: pageKey, query: '', scope, includeOtherCount: scope !== undefined, force: true });
    };
    useChatReconnect(retry, !!fetchError);
    // Query identity and freshness drive loads; the instance deduplicates both surfaces.
    useEffect(() => {
        if (!user) return;
        if (filter && itemKey) void loadByItem({ key: itemKey, filter });
    }, [user?.id, itemKey, filter, loadByItem, itemView.loadedAt]);
    useEffect(() => {
        if (user && !useItems) void loadPage({ key: pageKey, query: '', scope, includeOtherCount: scope !== undefined });
    }, [user?.id, pageKey, scope, useItems, loadPage, activeView.loadedAt]);

    const handleSelectThread = async (thread: ThreadData) => {
        if (!user || thread.id === currentThreadId) return;
        try {
            await loadThread({
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
            console.error('RecentChats: error loading thread:', error);
        }
    };

    const handleViewAll = async () => {
        let filter: ThreadItemFilter | null = null;
        if (contextType === 'file' || contextType === 'note') {
            const ctx = getReaderOrNoteContextItem(selectedTabId);
            // buildThreadItemFilter returns null for excluded/invalid items
            if (ctx) filter = await buildThreadItemFilter(ctx.item, searchableLibraryIds);
        }
        // Explicit null for the generic "Recent" case opens the view unfiltered
        setFilter(filter);
        setIsThreadListView(true);
    };

    // No data yet — render nothing until first load completes
    if (!isLoaded && threads.length === 0) return null;
    // Loaded but no threads exist
    if (isLoaded && threads.length === 0 && !isFetching && !fetchError) return null;

    const headerLabel = contextType === 'file' ? 'Related to this file'
        : contextType === 'note' ? 'Related to this note'
        : 'Recent';

    return (
        <div className={`pt-2 recent-chats${hasPopupMessages ? ' recent-chats-faded' : ''}`}>
            <div className="recent-chats-header">
                <span className="recent-chats-label">
                    {headerLabel}
                    {isFetching && threads.length > 0 && (
                        <Spinner size={11} />
                    )}
                </span>
                <Button
                    variant="ghost-secondary"
                    onClick={handleViewAll}
                    style={{ padding: '0px' }}
                >
                    View All
                </Button>
            </div>
            {fetchError && <ChatLoadFailure error={fetchError} retry={retry} loading={isFetching} />}
            {threads.map(thread => (
                <div
                    key={thread.id}
                    className="recent-chats-item"
                    role="button"
                    tabIndex={0}
                    aria-label={`${thread.name || 'Unnamed conversation'}, ${formatCompactTime(thread.updatedAt)}`}
                    onClick={() => handleSelectThread(thread)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectThread(thread);
                        }
                    }}
                >
                    <span className="recent-chats-item-name truncate">
                        {thread.name || 'Unnamed conversation'}
                    </span>
                    <span className="recent-chats-item-time">
                        {formatCompactTime(thread.updatedAt)}
                    </span>
                </div>
            ))}
        </div>
    );
};

export default RecentChats;
