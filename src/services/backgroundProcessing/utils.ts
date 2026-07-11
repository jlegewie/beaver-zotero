import type {
    AttachmentProcessingStateRecord,
    BackgroundJobInput,
    BackgroundJobPayload,
} from '../database';
import { getPref } from '../../utils/prefs';
import { BACKGROUND_UNTAG_PRIORITY } from './constants';

type ProcessableKind = AttachmentProcessingStateRecord['contentKind'];

export function backgroundProcessingEnabled(): boolean {
    return getPref('backgroundProcessingEnabled') === true;
}

export function getBackgroundProcessingSkipTokens(): Set<string> {
    const raw = getPref('backgroundProcessingLibrariesToSkip');
    if (typeof raw !== 'string' || raw.length === 0) return new Set();
    try {
        const parsed = JSON.parse(raw);
        return new Set(
            Array.isArray(parsed)
                ? parsed.filter((entry): entry is string => typeof entry === 'string')
                : [],
        );
    } catch {
        return new Set();
    }
}

export function backgroundProcessingLibraryToken(libraryId: number): string | null {
    const library = Zotero.Libraries.get(libraryId);
    if (!library) return null;
    if (library.libraryType === 'group') {
        const groupId = Zotero.Groups.getGroupIDFromLibraryID(libraryId);
        return groupId ? `G${groupId}` : null;
    }
    return library.libraryType === 'user' ? `L${libraryId}` : null;
}

/**
 * Library-exclusion boundary for background work. True only once the scope is
 * known, so unresolved startup states never read as excluded.
 */
export function isLibraryExcludedFromScope(libraryId: number): boolean {
    return Zotero.Beaver?.libraryScopeInitialized === true
        && !(Zotero.Beaver.searchableLibraryIds ?? []).includes(libraryId);
}

export function isBackgroundProcessingLibraryEnabled(libraryId: number): boolean {
    if (Zotero.Beaver?.libraryScopeInitialized !== true) return false;
    if (!(Zotero.Beaver?.searchableLibraryIds ?? []).includes(libraryId)) return false;
    const token = backgroundProcessingLibraryToken(libraryId);
    return token !== null && !getBackgroundProcessingSkipTokens().has(token);
}

export function buildBackgroundExtractPayload(kind: ProcessableKind): BackgroundJobPayload {
    if (kind === 'pdf') {
        return {
            content_kind: 'pdf',
            maxPages: null,
            maxFileSizeMB: 0,
            timeoutSeconds: 120,
        };
    }
    return { content_kind: kind } as BackgroundJobPayload;
}

export function buildIndexJobPayload(
    kind: ProcessableKind,
    options: {
        indexAction?: 'upsert' | 'untag';
        docHash?: string;
        previousDocumentHash?: string;
    } = {},
): BackgroundJobPayload {
    const base = buildBackgroundExtractPayload(kind);
    return {
        ...base,
        index_action: options.indexAction ?? 'upsert',
        ...(options.docHash ? { doc_hash: options.docHash } : {}),
        ...(options.previousDocumentHash
            ? { previous_doc_hash: options.previousDocumentHash }
            : {}),
    } as BackgroundJobPayload;
}

/** Untag job for a ledger row whose indexed content is being dropped. */
export function buildUntagJobInput(
    row: AttachmentProcessingStateRecord,
    now: number,
): BackgroundJobInput {
    return {
        jobType: 'fulltext_untag',
        libraryId: row.libraryId,
        itemId: row.itemId,
        zoteroKey: row.zoteroKey,
        contentKind: row.contentKind,
        payloadKind: 'structured',
        priority: BACKGROUND_UNTAG_PRIORITY,
        payload: buildIndexJobPayload(row.contentKind, {
            indexAction: 'untag',
            docHash: row.structuredDocumentHash!,
        }),
        now,
    };
}

