import { VoyageClient } from "./voyage";
import { VectorStoreDB } from "./vectorStore";

export interface ProcessingData {
    itemId: number;
    title: string;
    abstract: string;
}

export async function collectItemData(item: Zotero.Item): Promise<ProcessingData> {
    const title = item.getField('title') as string;
    const abstract = item.getField('abstract') as string;
    
    return {
        itemId: item.id,
        title,
        abstract
    };
}

export async function processAndStoreItem(
    data: ProcessingData,
    voyageClient: VoyageClient,
    vectorStore: VectorStoreDB
): Promise<number> {
    // Combine title and abstract for embedding
    const combinedText = `${data.title}\n\n${data.abstract}`;
    
    // Get embedding
    const embedding = await voyageClient.embedDocument(combinedText);
    
    // Store in vector database
    const docId = await vectorStore.insertDocument({
        item_id: data.itemId,
        parent_id: null,
        status: "processed",
        summary: "",
        embedding: new Float32Array(embedding),
        embedding_model: "voyage-3-lite",
        timestamp: Date.now()
    });
    
    return docId;
} 