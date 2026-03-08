import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { zoteroContextAtom } from '../atoms/zoteroContext';
import { isThreadListViewAtom } from '../atoms/ui';
import { ThreadData, loadThreadAtom } from '../atoms/threads';
import { currentThreadIdAtom } from '../agents/atoms';
import { threadService, ThreadRunMatch } from '../../src/services/threadService';
import { convertUTCToLocal } from '../utils/dateUtils';

const MAX_RECENT = 3;
const CACHE_TTL = 60_000; // 1 minute

interface CacheEntry {
    threads: ThreadData[];
    isContextSpecific: boolean;
    timestamp: number;
}

// Module-level cache persists across mount/unmount cycles
const recentCache = new Map<string, CacheEntry>();

export function clearRecentChatsCache() {
    recentCache.clear();
}

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

/** Deduplicate ThreadRunMatch[] by thread ID, keeping first occurrence (most recent). */
function deduplicateByThread(matches: ThreadRunMatch[]): ThreadData[] {
    const seen = new Map<string, ThreadData>();
    for (const m of matches) {
        if (!seen.has(m.id)) {
            seen.set(m.id, {
                id: m.id,
                name: m.name || '',
                createdAt: m.created_at,
                updatedAt: m.updated_at,
            });
        }
    }
    return Array.from(seen.values());
}

const RecentChats: React.FC = () => {
    const user = useAtomValue(userAtom);
    const zoteroContext = useAtomValue(zoteroContextAtom);
    const setIsThreadListView = useSetAtom(isThreadListViewAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);

    const [threads, setThreads] = useState<ThreadData[]>([]);
    const [isContextSpecific, setIsContextSpecific] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);

    // Clear cache on mount so returning to home always shows fresh data
    const hasMountedRef = useRef(false);

    const fetchRecentChats = useCallback(async (isCancelled: () => boolean) => {
        if (!user) return;

        const contextType = zoteroContext.type;
        const attachment = zoteroContext.readerAttachment;
        const attachmentKey = attachment?.key || null;
        const libraryId = attachment?.libraryID;

        // Cache key: differentiate library vs reader-per-attachment
        let cacheKey: string;
        if (contextType === 'reader' && attachmentKey) {
            cacheKey = `${user.id}:reader:${attachmentKey}`;
        } else {
            // TODO: when note support is added, use `note:${noteKey}` similar to reader
            cacheKey = `${user.id}:library`;
        }

        // On first mount, clear cache for fresh data; subsequent renders use TTL
        if (!hasMountedRef.current) {
            recentCache.delete(cacheKey);
            hasMountedRef.current = true;
        }

        // Check cache
        const cached = recentCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            if (isCancelled()) return;
            setThreads(cached.threads);
            setIsContextSpecific(cached.isContextSpecific);
            setIsLoaded(true);
            return;
        }

        try {
            let resultThreads: ThreadData[] = [];
            let contextSpecific = false;

            // Reader context: try attachment-specific threads first
            if (contextType === 'reader' && attachmentKey && libraryId != null) {
                try {
                    const matches = await threadService.findThreadsByItem(
                        libraryId, [attachmentKey], 'attachments'
                    );
                    if (isCancelled()) return;
                    const deduped = deduplicateByThread(matches);
                    if (deduped.length > 0) {
                        resultThreads = deduped.slice(0, MAX_RECENT);
                        contextSpecific = true;
                    }
                } catch (err) {
                    if (isCancelled()) return;
                    console.error('RecentChats: error fetching attachment threads:', err);
                }
            }

            // TODO: 'note' context — use findThreadsByItem for the note's parent item
            // when note support is fully implemented. For now, fall through to general chats.

            // Fallback: general recent chats
            if (resultThreads.length === 0) {
                const response = await threadService.getPaginatedThreads(MAX_RECENT);
                if (isCancelled()) return;
                resultThreads = response.data.map(t => ({
                    id: t.id,
                    name: t.name || '',
                    createdAt: t.created_at,
                    updatedAt: t.updated_at,
                }));
                contextSpecific = false;
            }

            if (isCancelled()) return;
            setThreads(resultThreads);
            setIsContextSpecific(contextSpecific);

            recentCache.set(cacheKey, {
                threads: resultThreads,
                isContextSpecific: contextSpecific,
                timestamp: Date.now(),
            });
        } catch (error) {
            if (isCancelled()) return;
            console.error('RecentChats: error fetching threads:', error);
        } finally {
            if (!isCancelled()) {
                setIsLoaded(true);
            }
        }
    }, [user, zoteroContext.type, zoteroContext.readerAttachment?.key]);

    // Fetch on mount and when context changes (e.g. library ↔ reader tab switch)
    useEffect(() => {
        let cancelled = false;
        const isCancelled = () => cancelled || !!Zotero.__beaverShuttingDown;
        fetchRecentChats(isCancelled);
        return () => { cancelled = true; };
    }, [fetchRecentChats]);

    const handleSelectThread = async (threadId: string, threadName?: string) => {
        if (!user || threadId === currentThreadId) return;
        try {
            await loadThread({ user_id: user.id, threadId, threadName });
        } catch (error) {
            console.error('RecentChats: error loading thread:', error);
        }
    };

    const handleViewAll = () => {
        setIsThreadListView(true);
    };

    // Return null while loading or if there are no chats
    if (!isLoaded || threads.length === 0) return null;

    const headerLabel = isContextSpecific ? 'Related to this file' : 'Recent';

    return (
        <div className="recent-chats">
            <div className="recent-chats-header">
                <span className="recent-chats-label">{headerLabel}</span>
                <span className="recent-chats-view-all" onClick={handleViewAll}>View All</span>
            </div>
            {threads.map(thread => (
                <div
                    key={thread.id}
                    className="recent-chats-item"
                    onClick={() => handleSelectThread(thread.id, thread.name)}
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
