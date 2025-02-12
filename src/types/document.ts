/**
 * Metadata about a document that can be processed
 */
export interface ItemMetadata {
    itemId: number;
    title: string;
    abstract: string;
    year?: number;
    authors?: string;
    publication?: string;
    itemType: string;
    identifiers?: string;
}

/**
 * A processed Zotero item with embedding and status
 */
export interface ProcessedDocument extends ItemMetadata {
    id: string;
    embedding?: Float32Array;
    status: 'pending' | 'processed' | 'error';
    timestamp: number;
    error?: string;
}

/**
 * A chunk of text extracted from a Zotero item or its attachments
 */
export interface DocumentChunk {
    documentId: number;
    content: string;
    embedding: Float32Array;
    sourceFile?: string;
    pageNumber?: number;
    timestamp: number;
}

/**
 * Query results when searching documents
 */
export interface QueryResult {
    document: ProcessedDocument;
    score: number;
}


/**
 * Repository interface for document storage operations
 */
export interface IDocumentRepository {
    /**
     * Insert a new document into storage
     * @returns The ID of the inserted document
     */
    insert(doc: ProcessedDocument): Promise<number>;
    
    /**
     * Retrieve a document by its ID
     */
    getById(id: string): Promise<ProcessedDocument | null>;
    
    /**
     * Delete a document by its ID
     */
    deleteById(id: string): Promise<void>;
    
    /**
     * Find similar documents using embedding
     * @param embedding The query embedding
     * @param limit Maximum number of results
     * @returns Array of documents with similarity scores
     */
    findSimilar(embedding: Float32Array, limit?: number): Promise<QueryResult[]>;
}

/**
 * Service interface for document processing operations
 */
export interface IDocumentService {
    /**
     * Process a Zotero item and store its document representation
     * @returns The ID of the processed document
     */
    processDocument(itemId: number, metadata: ItemMetadata): Promise<number>;
    
    /**
     * Retrieve a processed document
     */
    getDocument(id: string): Promise<ProcessedDocument | null>;
    
    /**
     * Delete a document and its associated data
     */
    deleteDocument(id: string): Promise<void>;
    
    /**
     * Search for similar documents using text query
     * @param text The search query
     * @param limit Maximum number of results
     */
    query(text: string, limit?: number): Promise<QueryResult[]>;
} 