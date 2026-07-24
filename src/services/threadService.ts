import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { libraryRefForLibraryID } from '../utils/libraryIdentity';


/**
 * Interface for the 'threads' table row
 * 
 * Table stores chat threads, mirroring the backend postgres structure.
 * Corresponds to the ThreadModel and threads table in the backend.
 * 
 */
export interface ThreadModel {
    id: string;
    user_id: string;
    name?: string;
    starred?: boolean;
    created_at: string;
    updated_at: string;
    // Zotero install identity of the device that created the thread.
    // Both null/absent for unattributed threads (visible on every instance).
    zotero_user_id?: string | null;
    zotero_local_id?: string | null;
}


/**
 * Thread+run match from findThreadsByItem.
 * One per (thread, run_id, match_type); same thread may appear multiple times.
 */
export interface ThreadRunMatch extends ThreadModel {
    run_id: string;
    match_type: 'user_attachment' | 'citation';
}

// Based on backend ThreadModel
export interface PaginatedThreadsResponse {
    data: ThreadModel[];
    next_cursor: string | null;
    has_more: boolean;
    total?: number;
    // Threads hidden by instance scoping. Only set on the first page of a
    // scoped paginated fetch that requested it; null/absent otherwise.
    other_instance_count?: number | null;
}

/**
 * A Zotero instance identity used to scope thread visibility: the Zotero
 * account userID (global, only when sync is enabled) and/or the install's
 * localUserKey. Plain data — callers derive it from their client environment
 * and pass it in; this service performs no identity lookups itself.
 */
export interface ZoteroInstanceRef {
    zoteroUserId?: string | null;
    zoteroLocalId?: string | null;
}

/** Appends the instance-scope query params for a `ZoteroInstanceRef`. */
function appendInstanceScopeParams(params: URLSearchParams, scope: ZoteroInstanceRef | undefined): void {
    if (scope?.zoteroUserId) params.set('zotero_user_id', scope.zoteroUserId);
    if (scope?.zoteroLocalId) params.set('zotero_local_id', scope.zoteroLocalId);
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
    async getThread(threadId: string): Promise<ThreadModel> {
        return this.get<ThreadModel>(`/api/v1/threads/${threadId}`);
    }

    /**
     * Renames a thread
     * @param threadId The ID of the thread to rename
     * @param newName The new name for the thread
     * @returns Promise with the updated thread data
     */
    async renameThread(threadId: string, newName: string): Promise<ThreadModel> {
        return this.patch<ThreadModel>(`/api/v1/threads/${threadId}/rename`, { new_name: newName });
    }

    /**
     * Deletes a thread
     * @param threadId The ID of the thread to delete
     * @returns Promise that resolves when the thread is deleted
     */
    async deleteThread(threadId: string): Promise<void> {
        return this.delete(`/api/v1/threads/${threadId}`);
    }

    /**
     * Finds threads where Zotero items appear as user attachments or citations.
     * @param libraryId Zotero library ID
     * @param zoteroKeys Zotero item keys to search for
     * @param mode Search in attachments, citations, or both
     * @returns List of thread+run matches (thread may appear multiple times).
     *   NOTE: No ordering guarantee — callers must sort client-side if order matters.
     *
     * Sends the device-portable `library_ref` ("u" / "g<groupID>") alongside the
     * device-local `libraryId` so the backend also matches group-library items
     * written on another device (where the local library_id differs). Legacy
     * rows with no stored library_ref still match by the numeric library_id.
     */
    async findThreadsByItem(
        libraryId: number,
        zoteroKeys: string[],
        mode: 'attachments' | 'citations' | 'both' = 'attachments'
    ): Promise<ThreadRunMatch[]> {
        const params = new URLSearchParams({
            library_id: String(libraryId),
            mode,
        });
        // Derive the portable ref (best-effort; null for the external-file sentinel
        // or when Zotero mapping is unavailable) and send it when present.
        const libraryRef = libraryRefForLibraryID(libraryId);
        if (libraryRef) {
            params.append('library_ref', libraryRef);
        }
        for (const key of zoteroKeys) {
            params.append('zotero_keys', key);
        }
        return this.get<ThreadRunMatch[]>(`/api/v1/threads/by-item?${params.toString()}`);
    }

    /**
     * Searches threads by name (case-insensitive).
     * @param q Search query (matches thread name)
     * @param limit Maximum number of threads to return (1–50)
     * @param after Cursor for pagination (thread ID)
     * @param scope Optional instance identity; when provided, results are
     *   scoped to threads matching it plus unattributed (NULL/NULL) threads
     * @returns Promise with paginated threads data
     */
    async searchThreads(
        q: string,
        limit: number = 10,
        after: string | null = null,
        scope?: ZoteroInstanceRef
    ): Promise<PaginatedThreadsResponse> {
        const params = new URLSearchParams({ q, limit: String(limit) });
        if (after) {
            params.set('after', after);
        }
        appendInstanceScopeParams(params, scope);
        return this.get<PaginatedThreadsResponse>(`/api/v1/threads/search?${params.toString()}`);
    }

    /**
     * Fetches paginated threads
     * @param limit Maximum number of threads to return
     * @param after Cursor for pagination (thread ID of the last item from previous page)
     * @param scope Optional instance identity; when provided, results are
     *   scoped to threads matching it plus unattributed (NULL/NULL) threads
     * @param includeOtherCount When scoped, also request the count of threads
     *   hidden by the scoping (returned on the first page only)
     * @returns Promise with paginated threads data
     */
    async getPaginatedThreads(
        limit: number = 10,
        after: string | null = null,
        scope?: ZoteroInstanceRef,
        includeOtherCount: boolean = false
    ): Promise<PaginatedThreadsResponse> {
        const params = new URLSearchParams({ limit: String(limit) });
        if (after) {
            params.set('after', after);
        }
        appendInstanceScopeParams(params, scope);
        if (includeOtherCount) {
            params.set('include_other_count', 'true');
        }
        return this.get<PaginatedThreadsResponse>(`/api/v1/threads/paginated?${params.toString()}`);
    }

    /**
     * Stamps the Zotero account id onto this install's pre-sync threads
     * (threads carrying the given localUserKey and no account id yet), making
     * them visible on the user's other synced devices. Idempotent.
     * @param scope The claiming instance identity (both ids required)
     * @param expectedUserId The Beaver user id the claim is intended for;
     *   verified server-side against the authenticated user
     * @returns Promise with the number of threads claimed
     */
    async claimThreads(
        scope: { zoteroUserId: string; zoteroLocalId: string },
        expectedUserId: string
    ): Promise<{ claimed: number }> {
        return this.post<{ claimed: number }>('/api/v1/threads/claim-instance', {
            zotero_local_id: scope.zoteroLocalId,
            zotero_user_id: scope.zoteroUserId,
            expected_user_id: expectedUserId,
        });
    }

    /**
     * Creates a new thread
     * @param name Optional name for the thread
     * @returns Promise with the created thread data
     */
    async createThread(name?: string): Promise<ThreadModel> {
        const payload = { name: name || null };
        return this.post<ThreadModel>('/api/v1/threads', payload);
    }

    /**
     * Fetches all starred threads, sorted by most recently updated
     * @returns Promise with the list of starred threads
     */
    async getStarredThreads(): Promise<ThreadModel[]> {
        return this.get<ThreadModel[]>('/api/v1/threads/starred');
    }

    /**
     * Stars a thread
     * @param threadId The ID of the thread to star
     * @returns Promise with the updated thread data
     */
    async starThread(threadId: string): Promise<ThreadModel> {
        return this.patch<ThreadModel>(`/api/v1/threads/${threadId}/star`, {});
    }

    /**
     * Unstars a thread
     * @param threadId The ID of the thread to unstar
     * @returns Promise with the updated thread data
     */
    async unstarThread(threadId: string): Promise<ThreadModel> {
        return this.patch<ThreadModel>(`/api/v1/threads/${threadId}/unstar`, {});
    }
}

// Export threadService
export const threadService = new ThreadService(API_BASE_URL);