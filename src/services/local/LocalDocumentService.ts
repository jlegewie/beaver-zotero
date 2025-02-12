import { ProcessedDocument, ItemMetadata, QueryResult, IDocumentRepository, IDocumentService } from '../../types/document';
import { VoyageClient } from '../voyage';
import { generateUUID } from '../../utils/uuid';

export class LocalDocumentService implements IDocumentService {
    constructor(
        private repository: IDocumentRepository,
        private embedder: VoyageClient
    ) {}
    
    async processDocument(itemId: number, metadata: ItemMetadata): Promise<number> {
        // Create combined text for embedding
        const combinedText = `${metadata.title}\n\n${metadata.abstract}`;
        
        try {
            // Generate embedding
            const embedding = await this.embedder.embedDocument(combinedText);
            
            // Create document
            const doc: ProcessedDocument = {
                id: generateUUID(),
                ...metadata,
                embedding: new Float32Array(embedding),
                status: 'processed',
                timestamp: Date.now()
            };
            
            // Store document
            return await this.repository.insert(doc);
        } catch (error) {
            // Create error document
            const doc: ProcessedDocument = {
                id: generateUUID(),
                ...metadata,
                status: 'error',
                error: (error as Error).message,
                timestamp: Date.now()
            };
            
            return await this.repository.insert(doc);
        }
    }
    
    async getDocument(id: string): Promise<ProcessedDocument | null> {
        return await this.repository.getById(id);
    }
    
    async deleteDocument(id: string): Promise<void> {
        await this.repository.deleteById(id);
    }
    
    async query(text: string, limit: number = 5): Promise<QueryResult[]> {
        // Generate embedding for query text
        const embedding = await this.embedder.embedQuery(text);
        
        // Search for similar documents
        return await this.repository.findSimilar(new Float32Array(embedding), limit);
    }
} 