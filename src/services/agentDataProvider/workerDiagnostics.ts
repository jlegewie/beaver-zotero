/**
 * Worker health snapshots for PDF-op timeout responses.
 *
 * The backend cannot see plugin logs in production; attaching a compact
 * snapshot of the serving worker slot to timeout error responses lets a
 * backend trace distinguish a wedged worker (lease reap, respawn churn)
 * from a merely slow operation.
 */
import {
    getExistingMuPDFWorkerClient,
    type PDFWorkerSlotName,
} from '../../beaver-extract';
import { WSWorkerDiagnostics } from '../agentProtocol';

/**
 * Collect a compact health snapshot of a PDF worker slot. Returns null when
 * the slot has never spawned a client. Never throws — diagnostics must not
 * break the error path they annotate.
 *
 * @param leaseReaped whether the failure being reported was produced by the
 *   busy-lease watchdog (callers classify via `isWorkerDeadlineError`).
 */
export function collectWorkerDiagnostics(
    slot: PDFWorkerSlotName,
    leaseReaped: boolean,
): WSWorkerDiagnostics | null {
    try {
        const client = getExistingMuPDFWorkerClient(slot);
        if (!client) return null;
        const stats = client.getStats();
        const oldestStartedAt = client.oldestInFlightStartedAt;
        return {
            slot,
            lease_reaped: leaseReaped,
            lease_reap_count: stats.leaseReapCount,
            last_lease_reap_op: stats.lastLeaseReapOp,
            last_lease_reap_age_ms: stats.lastLeaseReapAgeMs,
            spawn_count: stats.spawnCount,
            retry_count: stats.retryCount,
            consecutive_start_failures: stats.consecutiveStartFailures,
            has_worker: stats.hasWorker,
            in_flight: client.inFlight,
            oldest_in_flight_age_ms:
                oldestStartedAt === 0 ? null : Date.now() - oldestStartedAt,
        };
    } catch {
        return null;
    }
}

/**
 * Attach a hot-slot worker snapshot to a timeout error response.
 *
 * Attaches only when the request actually entered the worker slot
 * (`workerDispatched`): a timeout during item lookup, file download, or a
 * non-PDF document path must not be labeled with unrelated concurrent worker
 * activity. Returns the response unchanged when the request never reached
 * the worker or no client exists.
 */
export function withWorkerDiagnostics<
    T extends { worker_diagnostics?: WSWorkerDiagnostics | null },
>(
    response: T,
    opts: { workerDispatched: boolean; leaseReaped: boolean },
): T {
    if (!opts.workerDispatched) return response;
    const diagnostics = collectWorkerDiagnostics('hot', opts.leaseReaped);
    return diagnostics ? { ...response, worker_diagnostics: diagnostics } : response;
}

/**
 * Tracks whether a request has posted work to the PDF worker. Handlers create
 * one per request, call `mark()` immediately before each worker dispatch, and
 * pass `.value` into `withWorkerDiagnostics` so a timeout during item lookup
 * or file download is not labeled with unrelated worker activity.
 */
export function createWorkerDispatchFlag(): { mark: () => void; readonly value: boolean } {
    let dispatched = false;
    return {
        mark: () => {
            dispatched = true;
        },
        get value() {
            return dispatched;
        },
    };
}
