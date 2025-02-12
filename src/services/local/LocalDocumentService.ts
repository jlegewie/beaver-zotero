import { Document, DocumentMetadata, QueryResult, IDocumentRepository, IDocumentService } from '../../types/document';
import { VoyageClient } from '../voyage';

export class LocalDocumentService implements IDocumentService {
    constructor(
        private repository: IDocumentRepository,
        private embedder: VoyageClient
    ) {}
    
    async processDocument(itemId: number, metadata: DocumentMetadata): Promise<number> {
        // Create combined text for embedding
        const combinedText = `${metadata.title}\n\n${metadata.abstract}`;
        
        try {
            // Generate embedding
            const embedding = await this.embedder.embedDocument(combinedText);
            
            // Create document
            const doc: Document = {
                ...metadata,
                itemId,
                embedding: new Float32Array(embedding),
                status: 'processed',
                timestamp: Date.now()
            };
            
            // Store document
            return await this.repository.insert(doc);
        } catch (error) {
            // Create error document
            const doc: Document = {
                ...metadata,
                itemId,
                status: 'error',
                error: (error as Error).message,
                timestamp: Date.now()
            };
            
            return await this.repository.insert(doc);
        }
    }
    
    async getDocument(id: number): Promise<Document | null> {
        return await this.repository.getById(id);
    }
    
    async deleteDocument(id: number): Promise<void> {
        await this.repository.deleteById(id);
    }
    
    async query(text: string, limit: number = 5): Promise<QueryResult[]> {
        // Generate embedding for query text
        const embedding = await this.embedder.embedQuery(text);
        
        // Search for similar documents
        return await this.repository.findSimilar(new Float32Array(embedding), limit);
    }
} 