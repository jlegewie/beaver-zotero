import { ApiService } from './apiService';
import { ServerError, SessionRefreshError } from '../types/apiErrors';


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
    // Agent the thread belongs to, set server-side from the creating client
    // (see `setThreadAgentName`). Absent on responses from a backend that
    // predates the field.
    agent_name?: string | null;
}


/**
 * Thread+run match from findThreadsByItem.
 * One per (thread, run_id, match_type); same thread may appear multiple times.
 *
 * The by-item route takes no agent scope, so these rows carry every agent's
 * threads and callers must drop the foreign ones themselves — see
 * {@link isThreadAgentMismatch}.
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

/**
 * A library to search for item references, identified both ways: the
 * device-local `libraryId` and, when the caller can compute one, the
 * device-portable `libraryRef` ("u" / "g<groupID>").
 *
 * Sending both lets the backend also match group-library items written on
 * another device, where the local id differs; rows stored without a
 * `library_ref` still match on the numeric id. Plain data, like
 * {@link ZoteroInstanceRef} — callers derive the ref from their client
 * environment, since only they know how local ids map to portable ones.
 */
export interface ThreadItemLibraryRef {
    libraryId: number;
    libraryRef?: string | null;
}

/** Appends the instance-scope query params for a `ZoteroInstanceRef`. */
function appendInstanceScopeParams(params: URLSearchParams, scope: ZoteroInstanceRef | undefined): void {
    if (scope?.zoteroUserId) params.set('zotero_user_id', scope.zoteroUserId);
    if (scope?.zoteroLocalId) params.set('zotero_local_id', scope.zoteroLocalId);
}

let clientAgentName: string | null = null;

/**
 * Register the agent whose threads this client owns (the backend stamps the
 * same name on threads the client creates). Every thread-list request is then
 * scoped to it, so a user running two clients sees each client's own threads
 * rather than one merged list.
 *
 * Call once at host bundle init; `null` clears the scope. Hosts that do not
 * register a name keep the unscoped behavior of a client released before
 * per-agent thread lists existed: the list shows threads of every agent.
 */
export function setThreadAgentName(name: string | null): void {
    clientAgentName = name || null;
}

/** Appends the agent-scope query param when a host has registered a name. */
function appendAgentScopeParam(params: URLSearchParams): void {
    if (clientAgentName) params.set('agent_name', clientAgentName);
}

/**
 * Whether a thread belongs to a different agent than this client's, and so
 * must be hidden from results the backend did not scope (findThreadsByItem).
 *
 * `false` when this client registered no agent name, or when the thread has no
 * `agent_name` — a backend older than the field reports none, and hiding every
 * thread in that case would empty the list.
 */
export function isThreadAgentMismatch(thread: Pick<ThreadModel, 'agent_name'>): boolean {
    if (!clientAgentName) return false;
    if (!thread.agent_name) return false;
    return thread.agent_name !== clientAgentName;
}

/**
 * What the backend did with a thread truncation request.
 *
 * A refusal means the thread was rewritten elsewhere and nothing was deleted:
 * `'not_a_suffix'` when a run the request did not name sits after the first
 * named one (the thread was continued), `'tail_mismatch'` when the run that
 * would survive as the thread's last is not the one the client expected (the
 * tail was replaced or further truncated). Naming runs that no longer exist
 * while the expected tail still matches is a success with an empty
 * `deleted_run_ids` (idempotent no-op).
 */
export interface ThreadTruncationReport {
    deleted_run_ids: string[];
    refused_run_ids: string[];
    reason: 'not_a_suffix' | 'tail_mismatch' | null;
}

/**
 * Whether a truncate POST failed in a way a re-POST can answer: the request
 * may never have arrived (network, timeout) or died in transit (5xx). A 4xx
 * is a definitive answer already and must not be retried.
 */
function isRetryableTruncateFailure(error: unknown): boolean {
    return error instanceof ServerError || error instanceof SessionRefreshError;
}

/** Per-attempt deadline: the retry UI blocks on this call. */
const TRUNCATE_TIMEOUT_MS = 15000;

/**
 * Thread-specific API service that extends the base API service
 */
export class ThreadService extends ApiService {
    /**
     * Creates a new ThreadService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl?: string) {
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
     * @param library Library to search, as a {@link ThreadItemLibraryRef}
     * @param zoteroKeys Zotero item keys to search for
     * @param mode Search in attachments, citations, or both
     * @returns List of thread+run matches (thread may appear multiple times).
     *   NOTE: No ordering guarantee — callers must sort client-side if order matters.
     */
    async findThreadsByItem(
        library: ThreadItemLibraryRef,
        zoteroKeys: string[],
        mode: 'attachments' | 'citations' | 'both' = 'attachments'
    ): Promise<ThreadRunMatch[]> {
        const params = new URLSearchParams({
            library_id: String(library.libraryId),
            mode,
        });
        if (library.libraryRef) {
            params.append('library_ref', library.libraryRef);
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
        appendAgentScopeParam(params);
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
        appendAgentScopeParam(params);
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
     * Deletes explicitly named trailing runs from a thread — the commit point
     * of a retry. Nothing local may change until this resolves successfully.
     *
     * The endpoint is idempotent, so one network-shaped failure (timeout,
     * connection loss, 5xx) is answered with a single re-POST: a response
     * lost after the backend applied the deletion then resolves to a
     * definitive empty success instead of silent drift. 4xx responses are
     * definitive and rethrown as-is.
     *
     * @param threadId The ID of the thread to truncate
     * @param removedRunIds The run IDs the retry replaces (never inferred)
     * @param expectedTailRunId The run expected to remain the thread's last
     *   after the removal (null when the whole thread is named). The backend
     *   refuses with `tail_mismatch` when the surviving tail differs, which
     *   is what tells an idempotent replay apart from a retry against a
     *   thread rewritten elsewhere.
     * @returns Report of what the backend deleted or refused
     */
    async truncateThread(
        threadId: string,
        removedRunIds: string[],
        expectedTailRunId: string | null
    ): Promise<ThreadTruncationReport> {
        const endpoint = `/api/v1/agents/beaver/threads/${threadId}/truncate`;
        const body = {
            removed_run_ids: removedRunIds,
            expected_tail_run_id: expectedTailRunId,
        };
        try {
            return await this.post<ThreadTruncationReport>(endpoint, body, {
                timeoutMs: TRUNCATE_TIMEOUT_MS,
            });
        } catch (error) {
            if (!isRetryableTruncateFailure(error)) throw error;
            return await this.post<ThreadTruncationReport>(endpoint, body, {
                timeoutMs: TRUNCATE_TIMEOUT_MS,
            });
        }
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
        const params = new URLSearchParams();
        appendAgentScopeParam(params);
        const query = params.toString();
        return this.get<ThreadModel[]>(`/api/v1/threads/starred${query ? `?${query}` : ''}`);
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
export const threadService = new ThreadService();