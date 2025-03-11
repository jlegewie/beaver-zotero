import { ChatMessage } from '../../react/types/messages';
import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';

// Types that match the backend models
export interface Thread {
    id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
}

export interface ThreadMessage {
    id: string;
    thread_id: string;
    created_at: string;
    role: string;
    content: string;
    status: string;
    error: string | null;
}

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
    async getThreadMessages(threadId: string): Promise<ChatMessage[]> {
        const messages = await this.get<ThreadMessage[]>(`/threads/${threadId}/messages`);
        
        // Convert backend ThreadMessage to frontend ChatMessage format
        return messages.map(message => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system',
            content: message.content,
            status: message.status as 'searching' | 'thinking' | 'in_progress' | 'completed' | 'error',
            errorType: message.error || undefined
        }));
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