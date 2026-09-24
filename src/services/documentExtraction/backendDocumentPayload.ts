import type {
    BeaverExtractResult,
    DocumentItem,
    MarkdownExtractResult,
    StructuredDocument,
    StructuredExtractResult,
    StructuredPage,
} from '@beaver/agent-core/extract/schema';
import type { DocumentExtractResult, TextDocumentExtractResult } from '@beaver/agent-core/extract/document/shared/documentExtractResult';
import type { EpubDocument } from '@beaver/agent-core/extract/document/epub/schema';
import type { SnapshotDocument } from '@beaver/agent-core/extract/document/snapshot/schema';

export interface BackendDocumentPayloadOptions {
    /** Keep PDF `margin` items (running heads, page numbers, watermarks). */
    includeMargins?: boolean;
}

type StructuredBackendPayload = Omit<StructuredExtractResult, 'document'> & {
    content_kind?: 'pdf';
    document: Omit<StructuredDocument, 'citationIndex'>;
};

/** An extracted document in the form sent to the backend. */
export type BackendDocumentPayload =
    | Omit<EpubDocument, 'citationIndex'>
    | Omit<SnapshotDocument, 'citationIndex'>
    | StructuredBackendPayload
    | MarkdownExtractResult
    | TextDocumentExtractResult;

function isMarginItem(item: DocumentItem): boolean {
    return item.kind === 'margin';
}

function withoutMargins(page: StructuredPage): StructuredPage {
    return page.items.some(isMarginItem)
        ? { ...page, items: page.items.filter(item => !isMarginItem(item)) }
        : page;
}

/**
 * Project an extracted document to what the backend consumes.
 *
 * - `citationIndex` is omitted for every kind. It is derivable from the pages
 *   or sections, and the backend resolves ids from the document itself.
 * - PDF `margin` items are omitted unless requested. The backend neither
 *   indexes nor renders them, and watermarks drawn glyph by glyph can make them
 *   a large share of a document.
 *
 * Returns a shallow projection; the input (usually the local cache copy, which
 * local citation resolution and the structured document hash depend on) is
 * never mutated.
 */
export function toBackendDocumentPayload(
    document: DocumentExtractResult | BeaverExtractResult,
    options: BackendDocumentPayloadOptions = {},
): BackendDocumentPayload {
    if ('sections' in document) {
        const { citationIndex: _citationIndex, ...rest } = document;
        return rest;
    }
    if (document.mode !== 'structured') return document;
    const { citationIndex: _citationIndex, pages, ...rest } = document.document;
    return {
        ...document,
        document: {
            ...rest,
            pages: options.includeMargins ? pages : pages.map(withoutMargins),
        },
    };
}
