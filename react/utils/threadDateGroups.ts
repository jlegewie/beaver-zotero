import type { ThreadData } from '../../src/services/threads/types';
import { getDateGroup } from './dateUtils';

/** The date groups a chat history is bucketed into, in display order. */
export const THREAD_DATE_GROUPS = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'] as const;
export type ThreadDateGroup = typeof THREAD_DATE_GROUPS[number];

export interface ThreadDateGroupRows {
    label: ThreadDateGroup;
    threads: ThreadData[];
}

/** Buckets chats by the age of their last update, dropping empty groups. */
export function groupThreadsByDate(threads: ThreadData[]): ThreadDateGroupRows[] {
    const groups = new Map<ThreadDateGroup, ThreadData[]>(THREAD_DATE_GROUPS.map(label => [label, []]));
    for (const thread of threads) {
        groups.get(getDateGroup(thread.updatedAt) as ThreadDateGroup)?.push(thread);
    }
    return THREAD_DATE_GROUPS
        .map(label => ({ label, threads: groups.get(label) ?? [] }))
        .filter(group => group.threads.length > 0);
}
