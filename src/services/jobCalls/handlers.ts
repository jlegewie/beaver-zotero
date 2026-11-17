/**
 * The job-call data requests a chat run sends: `job_wait_request` (wait for a
 * job live) and `pdf_job_start_request` (group a `create_items` call's PDF
 * fetches into one job). Both reach the plugin-realm owners through
 * `Zotero.Beaver`, since this module also runs in the window bundle.
 */

import type { AgentDataRequestContext } from '@beaver/agent-core/transport/agentDataDispatch';
import type {
    WSJobWaitRequest,
    WSJobWaitResponse,
    WSPdfJobStartRequest,
    WSPdfJobStartResponse,
} from '@beaver/agent-core/protocol/jobCallProtocol';

export async function handleJobWaitRequest(
    request: WSJobWaitRequest,
    context?: AgentDataRequestContext,
): Promise<WSJobWaitResponse> {
    if (request.kind === 'table_fill' && Zotero.Beaver?.tableFills) {
        return Zotero.Beaver.tableFills.agent.waitJob(request, context);
    }
    if (request.kind === 'pdf_retrieval' && Zotero.Beaver?.pdfJobs) {
        return Zotero.Beaver.pdfJobs.waitJob(request, context);
    }
    return jobWaitFailure(request);
}

export function jobWaitFailure(request: Pick<WSJobWaitRequest, 'request_id' | 'job_id'>): WSJobWaitResponse {
    return { type: 'job_wait_response', request_id: request.request_id, job_id: request.job_id, status: 'not_found' };
}

export async function handlePdfJobStartRequest(
    request: WSPdfJobStartRequest,
    context?: AgentDataRequestContext,
): Promise<WSPdfJobStartResponse> {
    const jobs = Zotero.Beaver?.pdfJobs;
    if (!jobs) return pdfJobStartFailure(request, 'unavailable');
    return jobs.start(request, context);
}

export function pdfJobStartFailure(request: Pick<WSPdfJobStartRequest, 'request_id'>, code = 'internal_error'): WSPdfJobStartResponse {
    return {
        type: 'pdf_job_start_response',
        request_id: request.request_id,
        ok: false,
        error_code: code,
        error: 'Zotero could not follow the PDF downloads.',
    };
}
