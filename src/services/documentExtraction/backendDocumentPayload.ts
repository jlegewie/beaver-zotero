import type { BeaverExtractResult } from '@beaver/agent-core/extract/schema';
import type { DocumentExtractResult, TextDocumentExtractResult } from '@beaver/agent-core/extract/document/shared/documentExtractResult';
import type { EpubDocument } from '@beaver/agent-core/extract/document/epub/schema';
import type { SnapshotDocument } from '@beaver/agent-core/extract/document/snapshot/schema';

/** An extracted document in the form sent to the backend. */
export type BackendDocumentPayload =
    | Omit<EpubDocument, 'citationIndex'>
    | Omit<SnapshotDocument, 'citationIndex'>
    | BeaverExtractResult
    | TextDocumentExtractResult;

/**
 * Project an extracted document to what the backend consumes.
 *
 * EPUB and snapshot documents drop their `citationIndex`: it is derivable
 * from the sections, and the backend resolves ids from the document itself.
 * PDF and text documents are already in backend form and pass through.
 *
 * Returns a shallow projection; the input (usually the local cache copy) is
 * never mutated.
 */
export function toBackendDocumentPayload(
    document: DocumentExtractResult | BeaverExtractResult,
): BackendDocumentPayload {
    if ('sections' in document) {
        const { citationIndex: _citationIndex, ...rest } = document;
        return rest;
    }
    return document;
}
