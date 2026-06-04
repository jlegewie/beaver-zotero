import type { PageGeometry } from '../../../beaver-extract/types';

export type ExtractContentKind = 'pdf' | 'epub' | 'text' | 'snapshot';
export type DocumentCachePageLabels = Record<string, string>;

export interface EpubSectionSummary {
    index: number;
    rawHref: string;
    label?: string;
    itemCount?: number;
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

export type ReadableContentKind = ExtractContentKind | 'image';

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
