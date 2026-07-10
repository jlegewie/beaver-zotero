import { ThreadRunMatch } from '../../src/services/threadService';
import { ThreadData } from '../atoms/threads';

/** Deduplicate ThreadRunMatch[] by thread ID, keeping the most-recent updated_at per thread, then sort newest-first. */
export function deduplicateByThread(matches: ThreadRunMatch[]): ThreadData[] {
    const seen = new Map<string, ThreadData>();
    for (const m of matches) {
        const existing = seen.get(m.id);
        if (!existing || m.updated_at > existing.updatedAt) {
            seen.set(m.id, {
                id: m.id,
                name: m.name || '',
                createdAt: m.created_at,
                updatedAt: m.updated_at,
            });
        }
    }
    return Array.from(seen.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
