import { ChatMessage } from '../../react/types/messages';

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
 * Fetches a thread by its ID
 * @param backendUrl The base URL of the backend API
 * @param threadId The ID of the thread to fetch
 * @returns Promise with the thread data
 */
export async function getThread(
    backendUrl: string,
    threadId: string
): Promise<Thread> {
    const endpoint = `${backendUrl}/threads/${threadId}`;
    
    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
                // Add authorization headers if needed
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch thread: ${response.statusText}`);
        }

        const data = await response.json() as unknown;
        return data as Thread;
    } catch (error) {
        console.error('Error fetching thread:', error);
        throw error;
    }
}

/**
 * Fetches messages for a specific thread
 * @param backendUrl The base URL of the backend API
 * @param threadId The ID of the thread
 * @returns Promise with an array of messages
 */
export async function getThreadMessages(
    backendUrl: string,
    threadId: string
): Promise<ChatMessage[]> {
    const endpoint = `${backendUrl}/threads/${threadId}/messages`;
    
    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
                // Add authorization headers if needed
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch thread messages: ${response.statusText}`);
        }

        const data = await response.json() as unknown;
        const messages = data as ThreadMessage[];
        
        // Convert backend ThreadMessage to frontend ChatMessage format
        return messages.map(message => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system',
            content: message.content,
            status: message.status as 'searching' | 'thinking' | 'in_progress' | 'completed' | 'error',
            errorType: message.error || undefined
        }));
    } catch (error) {
        console.error('Error fetching thread messages:', error);
        throw error;
    }
}

/**
 * Renames a thread
 * @param backendUrl The base URL of the backend API
 * @param threadId The ID of the thread to rename
 * @param newName The new name for the thread
 * @returns Promise with the updated thread data
 */
export async function renameThread(
    backendUrl: string,
    threadId: string,
    newName: string
): Promise<Thread> {
    // The FastAPI endpoint expects new_name in the request body
    const endpoint = `${backendUrl}/threads/${threadId}/rename`;
    
    try {
        const response = await fetch(endpoint, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
                // Add authorization headers if needed
            },
            body: JSON.stringify({ new_name: newName })
        });

        if (!response.ok) {
            throw new Error(`Failed to rename thread: ${response.statusText}`);
        }

        const data = await response.json() as unknown;
        return data as Thread;
    } catch (error) {
        console.error('Error renaming thread:', error);
        throw error;
    }
}

/**
 * Deletes a thread
 * @param backendUrl The base URL of the backend API
 * @param threadId The ID of the thread to delete
 * @returns Promise that resolves when the thread is deleted
 */
export async function deleteThread(
    backendUrl: string,
    threadId: string
): Promise<void> {
    const endpoint = `${backendUrl}/threads/${threadId}`;
    
    try {
        const response = await fetch(endpoint, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
                // Add authorization headers if needed
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to delete thread: ${response.statusText}`);
        }

        // No content is returned on successful delete (204 status)
        return;
    } catch (error) {
        console.error('Error deleting thread:', error);
        throw error;
    }
}

/**
 * Fetches paginated threads
 * @param backendUrl The base URL of the backend API
 * @param limit Maximum number of threads to return
 * @param after Cursor for pagination (thread ID of the last item from previous page)
 * @returns Promise with paginated threads data
 */
export async function getPaginatedThreads(
    backendUrl: string,
    limit: number = 10,
    after: string | null = null
): Promise<PaginatedThreadsResponse> {
    let endpoint = `${backendUrl}/threads/paginated?limit=${limit}`;
    if (after) {
        endpoint += `&after=${after}`;
    }
    
    try {
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
                // Add authorization headers if needed
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch paginated threads: ${response.statusText}`);
        }

        const data = await response.json() as unknown;
        return data as PaginatedThreadsResponse;
    } catch (error) {
        console.error('Error fetching paginated threads:', error);
        throw error;
    }
} 