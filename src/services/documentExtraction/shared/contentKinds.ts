import type { PageGeometry } from '../../../beaver-extract/types';

export type ExtractContentKind = 'pdf' | 'epub' | 'text' | 'snapshot';
export type DocumentCachePageLabels = Record<string, string>;

export type ReadableContentKind = ExtractContentKind | 'image';

export type ContentKind =
    | ReadableContentKind
    | 'word'
    | 'spreadsheet'
    | 'presentation'
    | 'audio'
    | 'video'
    | 'archive'
    | 'linked_url'
    | 'other';

export type ContentInfoStatus = 'readable' | 'unreadable' | 'processing';

/** Display subset of attachment metadata */
export interface AttachmentStub {
    attachment_id: string;
    /** Device-portable library identity ("u" | "g<groupID>") of the attachment referenced by `attachment_id`. */
    library_ref?: string;
    parent_item_id?: string | null;
    title?: string | null;
    filename?: string | null;
    content_kind: ContentKind;
}

export interface AttachmentInfo extends AttachmentStub {
    status: ContentInfoStatus;
    status_code?: string | null;
    status_reason?: string | null;
    page_count?: number | null;
    line_count?: number | null;
    is_primary: boolean;
    annotations_count?: number | null;
}

export interface EpubSectionSummary {
    index: number;
    rawHref: string;
    label?: string;
    itemCount?: number;
    /**
     * 1-based page coordinate of the section's first extracted item.
     */
    firstPageNumber?: number;
    /**
     * 1-based page coordinate of the section's last extracted item. With
     * `firstPageNumber` this gives the section's full page span, used to report
     * the reader's current-page range. Absent on cache rows written before this
     * field existed.
     */
    lastPageNumber?: number;
}

export interface SnapshotSectionSummary {
    index: number;
    title?: string;
    itemCount?: number;
}

export type CachedDocumentMetadata =
    | {
        content_kind: 'pdf';
        pageCount: number | null;
        pageLabels: DocumentCachePageLabels | null;
        pages: (PageGeometry | null)[] | null;
    }
    | {
        content_kind: 'epub';
        sectionCount: number;
        sections: EpubSectionSummary[];
        /**
         * Total page count, based on the max stamped EPUB page coordinate.
         */
        pageCount?: number | null;
        /**
         * Total extracted text characters from the extraction diagnostics.
         * Lets the read side flag image-only/scanned EPUBs (sections but no
         * text) as unreadable without re-extracting. Missing values mean
         * unknown, not zero.
         */
        extractedTextChars?: number | null;
    }
    | {
        content_kind: 'text';
        lineCount: number;
        sourceContentType: string;
    }
    | {
        content_kind: 'snapshot';
        title?: string;
        sections?: SnapshotSectionSummary[];
        /** Total synthetic page count, based on the max stamped page coordinate. */
        pageCount?: number | null;
        /**
         * Total extracted text characters from the extraction diagnostics. Lets
         * the read side flag text-empty snapshots as unreadable without
         * re-extracting. Missing values mean unknown, not zero.
         */
        extractedTextChars?: number | null;
    };

const EXTRACT_CONTENT_KINDS: ReadonlySet<string> = new Set([
    'pdf',
    'epub',
    'text',
    'snapshot',
]);

export function isExtractContentKind(value: string): value is ExtractContentKind {
    return EXTRACT_CONTENT_KINDS.has(value);
}

const READABLE_CONTENT_KINDS: ReadonlySet<string> = new Set([
    ...EXTRACT_CONTENT_KINDS,
    'image',
]);

export function isReadableContentKind(value: string): value is ReadableContentKind {
    return READABLE_CONTENT_KINDS.has(value);
}

export function readableToExtractKind(
    kind: ReadableContentKind | null | undefined,
): ExtractContentKind | undefined {
    return kind === 'image' || kind == null ? undefined : kind;
}

/**
 * Parse durable document metadata and reject rows whose column kind and JSON
 * discriminator disagree.
 */
export function parseCachedDocumentMetadata(
    contentKind: string | null | undefined,
    json: string | null | undefined,
): CachedDocumentMetadata | null {
    if (!contentKind || !isExtractContentKind(contentKind) || !json) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const discriminator = (parsed as { content_kind?: unknown }).content_kind;
    if (discriminator !== contentKind || typeof discriminator !== 'string') {
        return null;
    }
    if (!isExtractContentKind(discriminator)) {
        return null;
    }

    return parsed as CachedDocumentMetadata;
}

export function buildPdfCachedMetadata(
    pageCount: number | null,
    pageLabels: DocumentCachePageLabels | null,
    pages: (PageGeometry | null)[] | null,
): CachedDocumentMetadata {
    return {
        content_kind: 'pdf',
        pageCount,
        pageLabels,
        pages,
    };
}

export function buildEpubCachedMetadata(
    sections: EpubSectionSummary[],
    extractedTextChars?: number | null,
    pageCount?: number | null,
): CachedDocumentMetadata {
    return {
        content_kind: 'epub',
        sectionCount: sections.length,
        sections,
        pageCount: pageCount ?? null,
        extractedTextChars: extractedTextChars ?? null,
    };
}

export function buildSnapshotCachedMetadata(
    sections: SnapshotSectionSummary[],
    title?: string,
    pageCount?: number | null,
    extractedTextChars?: number | null,
): CachedDocumentMetadata {
    return {
        content_kind: 'snapshot',
        ...(title ? { title } : {}),
        sections,
        pageCount: pageCount ?? null,
        extractedTextChars: extractedTextChars ?? null,
    };
}
