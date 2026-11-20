/**
 * `job_wait_request`: a chat run waits for a job live. Reaches the
 * plugin-realm fill service through `Zotero.Beaver`, since this module also
 * runs in the window bundle.
 */

import type { AgentDataRequestContext } from '@beaver/agent-core/transport/agentDataDispatch';
import type { WSJobWaitRequest, WSJobWaitResponse } from '@beaver/agent-core/protocol/jobCallProtocol';

export async function handleJobWaitRequest(
    request: WSJobWaitRequest,
    context?: AgentDataRequestContext,
): Promise<WSJobWaitResponse> {
    if (request.kind === 'table_fill' && Zotero.Beaver?.tableFills) {
        return Zotero.Beaver.tableFills.agent.waitJob(request, context);
    }
    return jobWaitFailure(request);
}

export function jobWaitFailure(request: Pick<WSJobWaitRequest, 'request_id' | 'job_id'>): WSJobWaitResponse {
    return { type: 'job_wait_response', request_id: request.request_id, job_id: request.job_id, status: 'not_found' };
}
