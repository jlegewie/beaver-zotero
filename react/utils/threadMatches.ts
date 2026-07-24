import type { ThreadModel, ThreadRunMatch, ZoteroInstanceRef } from '../../src/services/threadService';
import type { ThreadData } from '../atoms/threads';

/** The `ThreadModel` fields the UI mapping needs (sources like the Supabase
 * realtime feed select exactly these columns rather than full rows). */
type ThreadDataSource = Pick<
    ThreadModel,
    'id' | 'name' | 'created_at' | 'updated_at' | 'zotero_user_id' | 'zotero_local_id'
>;

/**
 * Maps a backend thread row (snake_case wire shape) to the UI's `ThreadData`.
 * The single mapping point — inline copies would silently drop the
 * instance-identity fields and make foreign threads look unattributed.
 */
export function threadModelToThreadData(thread: ThreadDataSource): ThreadData {
    return {
        id: thread.id,
        name: thread.name || '',
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        zoteroUserId: thread.zotero_user_id ?? null,
        zoteroLocalId: thread.zotero_local_id ?? null,
    };
}

/**
 * Whether a thread's stamped instance identity belongs to a different Zotero
 * instance than the current one. Pure: both identities are passed in.
 *
 * `false` (treated as matching) when the current identity is unknown, or the
 * stored identity is unattributed (both fields null), or either field matches.
 *
 * Every install has a local key (the account id only exists once Zotero sync is
 * on), so a `true` result always means a different Zotero profile — it is never
 * an account difference alone. UI copy can therefore say "profile" outright.
 */
export function isThreadInstanceMismatch(
    current: ZoteroInstanceRef | null,
    stored: ZoteroInstanceRef
): boolean {
    if (!current) return false;
    const storedUser = stored.zoteroUserId ?? null;
    const storedLocal = stored.zoteroLocalId ?? null;
    if (storedUser == null && storedLocal == null) return false;
    if (storedUser != null && storedUser === (current.zoteroUserId ?? null)) return false;
    if (storedLocal != null && storedLocal === (current.zoteroLocalId ?? null)) return false;
    return true;
}

/** Deduplicate ThreadRunMatch[] by thread ID, keeping the most-recent updated_at per thread, then sort newest-first. */
export function deduplicateByThread(matches: ThreadRunMatch[]): ThreadData[] {
    const seen = new Map<string, ThreadData>();
    for (const m of matches) {
        const existing = seen.get(m.id);
        if (!existing || m.updated_at > existing.updatedAt) {
            seen.set(m.id, threadModelToThreadData(m));
        }
    }
    return Array.from(seen.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
