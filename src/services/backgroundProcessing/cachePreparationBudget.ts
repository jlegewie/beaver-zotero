import type { BackgroundJobRecord } from '../database';
import type { DocumentCacheStats } from '../documentCache';

/** Leave headroom so preparation stops before ordinary cache eviction is needed. */
export function isCachePreparationFull(stats: DocumentCacheStats): boolean {
    return stats.payload_budget_bytes > 0
        && stats.payload_total_bytes >= stats.payload_budget_bytes * 0.9;
}

/**
 * Check the claimed job's budget. Retirement must still check persisted priority:
 * a foreground request can promote the ticket while this executor is waiting.
 */
export async function shouldStopCachePreparation(record: BackgroundJobRecord): Promise<boolean> {
    if (record.payload?.prepare_cache !== true || record.priority < 100) return false;
    const stats = await Zotero.Beaver?.documentCache?.getStats();
    return stats ? isCachePreparationFull(stats) : false;
}
