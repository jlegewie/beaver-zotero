/**
 * Drop local background-processing state so the next reconcile rebuilds from
 * scratch. Does not touch the document cache: tests reuse cached extractions,
 * and a cache wipe is a separate, explicit action.
 *
 * Queued jobs go too — leaving them would let the previous run's work land on
 * a ledger that no longer expects it. Untag jobs are included here (unlike
 * `deleteBackgroundJobsByLibrary`) because a reset promises an empty queue.
 */
export async function resetLocalProcessingState(
    libraryId?: number,
): Promise<{ libraryIds: number[] }> {
    const db = Zotero.Beaver?.db;
    if (!db) throw new Error('db not available');
    const conn = (db as unknown as {
        conn: { queryAsync: (sql: string, params?: unknown[]) => Promise<unknown> };
    }).conn;
    if (!conn?.queryAsync) throw new Error('db connection unavailable');

    const libraryIds = typeof libraryId === 'number'
        ? [libraryId]
        : Zotero.Libraries.getAll()
            .filter((library) => library.libraryType === 'user' || library.libraryType === 'group')
            .map((library) => library.libraryID);

    for (const id of libraryIds) {
        await conn.queryAsync(`DELETE FROM background_jobs WHERE library_id = ?`, [id]);
        await conn.queryAsync(`DELETE FROM background_jobs_dead WHERE library_id = ?`, [id]);
        await db.deleteAttachmentProcessingStatesByLibrary(id);
        await db.deleteProcessingIndexState(id);
    }
    if (typeof libraryId !== 'number') {
        await conn.queryAsync(`DELETE FROM document_processing_failures`);
    }
    return { libraryIds };
}
