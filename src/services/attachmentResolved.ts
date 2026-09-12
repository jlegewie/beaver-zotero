export interface AttachmentResolvedPayload {
    threadId?: string;
    actionId?: string;
    libraryId: number;
    zoteroKey: string;
    attachmentStatus: 'available' | 'failed';
    attachmentKey?: string;
    /**
     * Which resolver produced the file — one we supplied ('openalex') or one of
     * Zotero's own ('doi', 'url', 'oa', 'custom'). Without it the attach rate is
     * a single number with no way to tell which sources earn their place.
     */
    accessMethod?: string;
    /** Wall-clock duration of the whole fetch task. */
    elapsedMs?: number;
}
