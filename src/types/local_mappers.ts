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

// export function fromDocumentTable(table: DocumentTable): ProcessedDocument {
//     return {
//         id: table.id.toString(),
//         embedding: table.embedding,
//         status: table.status as 'pending' | 'processed' | 'error',
//         timestamp: table.timestamp
//     };
// }

// export function toChunkTable(chunk: DocumentChunk): Omit<ChunkTable, 'id'> {
//     return {
//         document_id: parseInt(chunk.documentId),
//         content: chunk.content,
//         page_no: chunk.pageNumber ?? null,
//         embedding: chunk.embedding,
//         embedding_model: 'current-model', // from config
//         timestamp: chunk.timestamp
//     };
// }

// export function fromChunkTable(table: ChunkTable): DocumentChunk {
//     return {
//         id: table.id.toString(),
//         documentId: table.document_id.toString(),
//         content: table.content,
//         embedding: table.embedding,
//         pageNumber: table.page_no ?? undefined,
//         timestamp: table.timestamp
//     };
// } 