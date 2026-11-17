/**
 * The parked-call mailbox: `POST /api/v1/threads/{thread_id}/parked-calls/{tool_call_id}/result`.
 * Stores a job's result on its parked call; starts no run.
 */

import { ApiService } from '@beaver/agent-core/transport/apiService';
import { isApiError } from '@beaver/agent-core/types/apiErrors';
import type {
    StoreJobResultRequest,
    StoreJobResultResponse,
} from '@beaver/agent-core/protocol/jobCallProtocol';
import type { PostOutcome } from './service';

const STORE_TIMEOUT_MS = 30_000;

export class JobCallApiClient extends ApiService {
    /** Throws on network and server errors (the caller retries); 404 reads as `not_found`. */
    async storeResult(threadId: string, toolCallId: string, body: StoreJobResultRequest): Promise<PostOutcome> {
        try {
            const response = await this.post<StoreJobResultResponse>(
                `/api/v1/threads/${encodeURIComponent(threadId)}/parked-calls/${encodeURIComponent(toolCallId)}/result`,
                body,
                { timeoutMs: STORE_TIMEOUT_MS },
            );
            const outcome = response?.outcome;
            if (outcome === 'stored' || outcome === 'busy' || outcome === 'gone') return outcome;
            throw new Error(`unexpected outcome ${String(outcome)}`);
        } catch (error) {
            if (isApiError(error) && (error.status === 404 || error.status === 403)) return 'not_found';
            // A body the server refuses as invalid will never be stored: drop it.
            if (isApiError(error) && (error.status === 400 || error.status === 422)) return 'gone';
            throw error;
        }
    }
}

export const jobCallApiClient = new JobCallApiClient();
