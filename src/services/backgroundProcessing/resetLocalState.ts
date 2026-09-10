/** Reset processing progress; only isolated tests may discard remote-cleanup state. */
export async function resetLocalProcessingState(
    libraryId?: number,
    options: { discardRemoteState?: boolean } = {},
): Promise<{ libraryIds: number[] }> {
    const db = Zotero.Beaver?.db;
    if (!db) throw new Error('db not available');
    const libraryIds = typeof libraryId === 'number'
        ? [libraryId]
        : Zotero.Libraries.getAll()
            .filter((library) => library.libraryType === 'user' || library.libraryType === 'group')
            .map((library) => library.libraryID);

    await db.resetLocalProcessingState(libraryId, options.discardRemoteState === true);
    return { libraryIds };
}

/** Clear local storage while its background consumers are suspended. */
export async function clearDocumentCache(resetProcessing = false): Promise<void> {
    const beaver = Zotero.Beaver;
    const cache = beaver?.documentCache;
    if (!cache) throw new Error('Document cache unavailable');
    await cache.runMaintenance(async () => {
        let resumeReconciler: (() => void) | undefined;
        let resumeExtractor: (() => void) | undefined;
        try {
            resumeReconciler = await beaver.processingReconciler?.suspendForMaintenance();
            resumeExtractor = await beaver.backgroundExtractor?.suspendForMaintenance();
            await cache.clearAll();
            if (resetProcessing) await resetLocalProcessingState();
        } finally {
            resumeExtractor?.();
            resumeReconciler?.();
        }
    });
}
