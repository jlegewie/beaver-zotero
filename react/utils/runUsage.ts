import { RunUsage } from '../agents/types';

/**
 * Returns input tokens for the latest model request in a run when determinable.
 *
 * - Preferred: last item from usage.model_requests (per-request backend data)
 * - Fallback: aggregate input_tokens when exactly one request was made
 * - Otherwise: null (cannot safely infer last-request input tokens)
 */
export function getLastRequestInputTokens(usage: RunUsage): number | null {
    if (usage.model_requests && usage.model_requests.length > 0) {
        const lastRequest = usage.model_requests[usage.model_requests.length - 1];
        if (typeof lastRequest.input_tokens === 'number') {
            return lastRequest.input_tokens;
        }
    }

    if (usage.requests === 1) {
        return usage.input_tokens;
    }

    return null;
}
