/**
 * Dev endpoints for table fills: drive `addon.tableFills` (plan, start, wait,
 * stop, status) and read a table's pending work, without the tab.
 */

import { pendingWork } from '@beaver/agent-core/layouts/tableFill';
import type { TableFillScope } from '@beaver/agent-core/protocol/tableFillProtocol';
import { readTable } from '../../artifacts/tableItemIdentity';
import type { TableFillSettings } from '../../tableFills/service';
import { errorResponse, MISSING_KEY, tableRefFrom, type TableStoreRequest } from './testTableHandlers';

export interface TableFillTestRequest extends TableStoreRequest {
    action?: 'plan' | 'start' | 'fill' | 'wait' | 'stop' | 'status' | 'dismiss' | 'configure';
    scope?: TableFillScope;
    planId?: string;
    jobId?: string;
    timeoutMs?: number;
    /** `configure`: settings for later jobs (`concurrency`, `commitRows`, `commitSeconds`, `maxRetries`). */
    settings?: Partial<Pick<TableFillSettings, 'concurrency' | 'commitRows' | 'commitSeconds' | 'maxRetries'>>;
}

const UNAVAILABLE = { ok: false, code: 'service_unavailable', error: 'The table fill service is not running.' };

/**
 * `action`:
 * - `plan` {key, scope?} → the plan summary.
 * - `start` {planId} → the job's first snapshot.
 * - `fill` {key, scope?} → plan and start at once.
 * - `wait` {jobId, timeoutMs?} → the snapshot once the job ended (or at the timeout).
 * - `stop` {jobId} → whether a running job was stopped.
 * - `status` {jobId} or {key} → a job's snapshot, or the table's job.
 * - `dismiss` {jobId} → forgets a finished job.
 * - `configure` {settings} → changes the service's settings for later rows.
 */
export async function handleTestTableFillHttpRequest(request: TableFillTestRequest = {}): Promise<any> {
    const fills = Zotero.Beaver.tableFills;
    if (!fills) return UNAVAILABLE;
    const action = request.action ?? 'status';
    try {
        switch (action) {
            case 'plan':
            case 'fill': {
                const ref = tableRefFrom(request);
                if (!ref) return MISSING_KEY;
                const planned = await fills.plan(ref, request.scope ?? { kind: 'pending' });
                if (!planned.ok || action === 'plan') return planned;
                const started = await fills.start(planned.plan.plan_id);
                return { ...started, plan: planned.plan };
            }
            case 'start':
                if (!request.planId) return { ok: false, code: 'invalid_request', error: 'planId is required' };
                return await fills.start(request.planId);
            case 'wait': {
                if (!request.jobId) return { ok: false, code: 'invalid_request', error: 'jobId is required' };
                const job = await fills.wait(request.jobId, request.timeoutMs);
                return job ? { ok: true, job } : { ok: false, code: 'not_found', error: 'No such job.' };
            }
            case 'stop':
                if (!request.jobId) return { ok: false, code: 'invalid_request', error: 'jobId is required' };
                return { ok: true, stopped: fills.stop(request.jobId), job: fills.getJob(request.jobId) };
            case 'dismiss':
                if (!request.jobId) return { ok: false, code: 'invalid_request', error: 'jobId is required' };
                fills.dismiss(request.jobId);
                return { ok: true };
            case 'configure':
                for (const [name, value] of Object.entries(request.settings ?? {})) {
                    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                        (fills.settings as unknown as Record<string, number>)[name] = value;
                }
                return {
                    ok: true,
                    settings: {
                        concurrency: fills.settings.concurrency,
                        commitRows: fills.settings.commitRows,
                        commitSeconds: fills.settings.commitSeconds,
                        maxRetries: fills.settings.maxRetries,
                    },
                };
            case 'status': {
                if (request.jobId) {
                    const job = fills.getJob(request.jobId);
                    return job ? { ok: true, job } : { ok: false, code: 'not_found', error: 'No such job.' };
                }
                const ref = tableRefFrom(request);
                if (!ref) return { ok: false, code: 'invalid_request', error: 'jobId or key is required' };
                return { ok: true, job: fills.jobForTable(ref) };
            }
            default:
                return { ok: false, code: 'invalid_request', error: `Unknown action ${String(action)}` };
        }
    } catch (error) {
        return errorResponse(error);
    }
}

/** `{key, libraryID?}` → the table's pending work as the Fill button counts it. */
export async function handleTestTablePendingHttpRequest(request: TableStoreRequest = {}): Promise<any> {
    const ref = tableRefFrom(request);
    if (!ref) return MISSING_KEY;
    try {
        const { spec, version } = await readTable(ref);
        return { ok: true, version, pending: pendingWork(spec) };
    } catch (error) {
        return errorResponse(error);
    }
}
