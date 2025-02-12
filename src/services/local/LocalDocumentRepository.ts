import { Document, QueryResult, IDocumentRepository } from '../../types/document';
import { VectorStoreDB } from '../vectorStore';

export class LocalDocumentRepository implements IDocumentRepository {
    constructor(private vectorStore: VectorStoreDB) {}
    
    async insert(doc: Document): Promise<number> {
        return await this.vectorStore.insertDocument({
            item_id: doc.itemId,
            parent_id: null,
            status: doc.status,
            summary: JSON.stringify({
                title: doc.title,
                abstract: doc.abstract,
                year: doc.year,
                author: doc.author,
                publication: doc.publication,
                itemType: doc.itemType
            }),
            embedding: doc.embedding!,
            embedding_model: 'voyage-3-lite',
            timestamp: doc.timestamp
        });
    }
    
    async getById(id: number): Promise<Document | null> {
        const doc = await this.vectorStore.getDocumentById(id);
        if (!doc) return null;
        
        const metadata = JSON.parse(doc.summary);
        return {
            id: doc.id,
            itemId: doc.item_id,
            title: metadata.title,
            abstract: metadata.abstract,
            year: metadata.year,
            author: metadata.author,
            publication: metadata.publication,
            itemType: metadata.itemType,
            embedding: doc.embedding,
            status: doc.status as 'pending' | 'processed' | 'error',
            timestamp: doc.timestamp
        };
    }
    
    async deleteById(id: number): Promise<void> {
        await this.vectorStore.deleteDocument(id);
    }
    
    async findSimilar(embedding: Float32Array, limit: number = 5): Promise<QueryResult[]> {
        const docs = await this.vectorStore.findSimilarDocuments(embedding, limit);
        return docs.map(doc => {
            const metadata = JSON.parse(doc.summary);
            return {
                document: {
                    id: doc.id,
                    itemId: doc.item_id,
                    title: metadata.title,
                    abstract: metadata.abstract,
                    year: metadata.year,
                    author: metadata.author,
                    publication: metadata.publication,
                    itemType: metadata.itemType,
                    embedding: doc.embedding,
                    status: doc.status as 'pending' | 'processed' | 'error',
                    timestamp: doc.timestamp
                },
                score: 1 - this.cosineSimilarity(embedding, doc.embedding)
            };
        });
    }
    
    private cosineSimilarity(a: Float32Array, b: Float32Array): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
} 