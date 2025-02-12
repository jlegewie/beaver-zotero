/**
 * Metadata about a document that can be processed
 */
export interface DocumentMetadata {
    title: string;
    abstract: string;
    year?: number;
    author?: string;
    publication?: string;
    itemType: string;
}

/**
 * A processed document with embedding and status
 */
export interface Document extends DocumentMetadata {
    id: number;           // Internal ID in our system
    itemId: number;      // Zotero item ID
    embedding?: Float32Array;
    status: 'pending' | 'processed' | 'error';
    timestamp: number;
    error?: string;      // Optional error message if status is 'error'
}

/**
 * Query results when searching documents
 */
export interface QueryResult {
    document: Document;
    score: number;       // Similarity score
}


/**
 * Repository interface for document storage operations
 */
export interface IDocumentRepository {
    /**
     * Insert a new document into storage
     * @returns The ID of the inserted document
     */
    insert(doc: Document): Promise<number>;
    
    /**
     * Retrieve a document by its ID
     */
    getById(id: number): Promise<Document | null>;
    
    /**
     * Delete a document by its ID
     */
    deleteById(id: number): Promise<void>;
    
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
    processDocument(itemId: number, metadata: DocumentMetadata): Promise<number>;
    
    /**
     * Retrieve a processed document
     */
    getDocument(id: number): Promise<Document | null>;
    
    /**
     * Delete a document and its associated data
     */
    deleteDocument(id: number): Promise<void>;
    
    /**
     * Search for similar documents using text query
     * @param text The search query
     * @param limit Maximum number of results
     */
    query(text: string, limit?: number): Promise<QueryResult[]>;
} 