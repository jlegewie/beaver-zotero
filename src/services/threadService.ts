import { v4 as uuidv4 } from 'uuid';
import { ChatMessage } from '../../react/types/messages';
import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ThreadSource } from '../../react/types/sources';
import { MessageModel } from '../../react/types/chat/api';
import { toMessageUI } from '../../react/types/chat/converters';

// Types that match the backend models
export interface Thread {
    id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
}

// Based on backend MessageModel
export interface PaginatedThreadsResponse {
    data: Thread[];
    next_cursor: string | null;
    has_more: boolean;
}

/**
 * Thread-specific API service that extends the base API service
 */
export class ThreadService extends ApiService {
    /**
     * Creates a new ThreadService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl: string) {
        super(backendUrl);
    }

    /**
     * Gets the base URL of this service
     * @returns The base URL
     */
    getBaseUrl(): string {
        return this.baseUrl;
    }

    /**
     * Fetches a thread by its ID
     * @param threadId The ID of the thread to fetch
     * @returns Promise with the thread data
     */
    async getThread(threadId: string): Promise<Thread> {
        return this.get<Thread>(`/threads/${threadId}`);
    }

    /**
     * Fetches messages for a specific thread
     * @param threadId The ID of the thread
     * @returns Promise with an array of messages
     */
    async getThreadMessages(threadId: string): Promise<{ messages: ChatMessage[], sources: ThreadSource[] }> {
        const messages = await this.get<MessageModel[]>(`/threads/${threadId}/messages`);
        
        // Convert backend MessageModel to frontend ChatMessage format
        const chatMessages = messages.map(toMessageUI);

        const sources: ThreadSource[] = [];
        
        for (const message of messages) {
            for (const attachment of message.attachments || []) {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.library_id, attachment.zotero_key);
                if (!item) continue;
                sources.push({
                    id: uuidv4(),
                    type: item.isNote() ? "note" : "attachment",
                    messageId: message.id,
                    libraryID: attachment.library_id,
                    itemKey: attachment.zotero_key,
                    parentKey: item.parentKey || null,
                    timestamp: Date.now(),
                    pinned: false,
                    childItemKeys: [],
                } as ThreadSource);
            }
        }

        return { messages: chatMessages, sources: sources };
    }

    /**
     * Renames a thread
     * @param threadId The ID of the thread to rename
     * @param newName The new name for the thread
     * @returns Promise with the updated thread data
     */
    async renameThread(threadId: string, newName: string): Promise<Thread> {
        return this.patch<Thread>(`/threads/${threadId}/rename`, { new_name: newName });
    }

    /**
     * Deletes a thread
     * @param threadId The ID of the thread to delete
     * @returns Promise that resolves when the thread is deleted
     */
    async deleteThread(threadId: string): Promise<void> {
        return this.delete(`/threads/${threadId}`);
    }

    /**
     * Fetches paginated threads
     * @param limit Maximum number of threads to return
     * @param after Cursor for pagination (thread ID of the last item from previous page)
     * @returns Promise with paginated threads data
     */
    async getPaginatedThreads(limit: number = 10, after: string | null = null): Promise<PaginatedThreadsResponse> {
        let endpoint = `/threads/paginated?limit=${limit}`;
        if (after) {
            endpoint += `&after=${after}`;
        }
        
        return this.get<PaginatedThreadsResponse>(endpoint);
    }

    /**
     * Creates a new thread
     * @param name Optional name for the thread
     * @returns Promise with the created thread data
     */
    async createThread(name?: string): Promise<Thread> {
        const payload = { name: name || null };
        return this.post<Thread>('/threads', payload);
    }
}

// Export threadService
export const threadService = new ThreadService(API_BASE_URL);