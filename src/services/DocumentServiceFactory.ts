import { IDocumentService } from '../types/document';
import { LocalDocumentService } from './local/LocalDocumentService';
import { LocalDocumentRepository } from './local/LocalDocumentRepository';
import { VectorStoreDB } from './vectorStore';
import { VoyageClient } from './voyage';

interface LocalConfig {
    mode: 'local';
    vectorStore: VectorStoreDB;
    voyageClient: VoyageClient;
}

interface RemoteConfig {
    mode: 'remote';
    baseUrl: string;
}

type ServiceConfig = LocalConfig | RemoteConfig;

export class DocumentServiceFactory {
    static create(config: ServiceConfig): IDocumentService {
        if (config.mode === 'local') {
            const repository = new LocalDocumentRepository(config.vectorStore);
            return new LocalDocumentService(repository, config.voyageClient);
        } else {
            throw new Error('Remote mode not implemented yet');
        }
    }
}