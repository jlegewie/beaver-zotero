import type { BackgroundJobInput } from '../database';
import type { DocumentCacheStats } from '../documentCache';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { BACKGROUND_EXTRACT_PRIORITY } from './constants';
import { isCachePreparationFull } from './cachePreparationBudget';
import { backgroundProcessingEnabled, buildBackgroundExtractPayload, isBackgroundProcessingLibraryEnabled } from './utils';

/** Find missing content only when explicit preparation has room to run. */
export async function getUncachedCandidates(stats: DocumentCacheStats, firstOnly = false) {
    if (!backgroundProcessingEnabled()) return [];
    const db = Zotero.Beaver?.db;
    if (!db) return [];
    if (isCachePreparationFull(stats)) return [];
    const candidates = await db.getUncachedProcessingCandidates({
        libraryIds: (Zotero.Beaver?.searchableLibraryIds ?? []).filter(isBackgroundProcessingLibraryEnabled),
        hasOcrAccess: Zotero.Beaver?.hasOcrAccess === true,
        firstOnly,
    });
    return candidates.filter((candidate) => isBackgroundProcessingLibraryEnabled(candidate.libraryId));
}

/** Explicitly prepare missing local content without resetting processing history. */
export async function prepareUncachedFiles(): Promise<number> {
    const beaver = Zotero.Beaver;
    if (!beaver?.documentCache || !beaver.db || !beaver.backgroundExtractor) {
        throw new Error('Background processing unavailable');
    }
    const { documentCache, backgroundExtractor, db } = beaver;
    let queued = 0;
    await documentCache.runMaintenance(async () => {
        const candidates = await getUncachedCandidates(await documentCache.getStats());
        const jobs: BackgroundJobInput[] = [];
        for (const candidate of candidates) {
            if (!backgroundProcessingEnabled() || !isBackgroundProcessingLibraryEnabled(candidate.libraryId)) continue;
            const item = await Zotero.Items.getByLibraryAndKeyAsync(candidate.libraryId, candidate.zoteroKey);
            if (!item || safeIsInTrash(item) === true) continue;
            const kind = getReadableContentKind(item);
            if (kind !== 'pdf' && kind !== 'epub' && kind !== 'snapshot') continue;
            if (!isBackgroundProcessingLibraryEnabled(candidate.libraryId)) continue;
            jobs.push({
                jobType: 'document_extract', libraryId: candidate.libraryId, zoteroKey: candidate.zoteroKey,
                itemId: item.id, contentKind: kind, payloadKind: 'structured',
                priority: BACKGROUND_EXTRACT_PRIORITY,
                payload: { ...buildBackgroundExtractPayload(kind), prepare_cache: true },
                now: Date.now(),
            });
        }
        if (backgroundProcessingEnabled()) {
            const allowed = jobs.filter((job) => isBackgroundProcessingLibraryEnabled(job.libraryId));
            await db.enqueueBackgroundJobs(allowed);
            if (allowed.length > 0) backgroundExtractor.requestImmediateDrain();
            queued = allowed.length;
        }
    });
    return queued;
}
