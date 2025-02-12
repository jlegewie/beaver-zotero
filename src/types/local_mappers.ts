import { DocumentTable, ChunkTable } from '../services/vectorStore';
import { ProcessedDocument, DocumentChunk } from './document';

/**
 * Maps domain entities to local database schema
 */
export function toDocumentTable(doc: ProcessedDocument): DocumentTable {
    return {
        id: doc.id,
        item_id: doc.itemId,
        status: doc.status,
        summary: "",
        embedding: doc.embedding!,
        embedding_model: 'current-model',
        timestamp: doc.timestamp
    } as DocumentTable;
}
