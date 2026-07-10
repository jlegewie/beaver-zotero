import { store } from '../store';
import { addPopupMessageAtom } from './popupMessageUtils';
import { logger } from '../../src/utils/logger';
import type { WorkerStartFailureInfo } from '../../src/beaver-extract';

// Only prompt after this many consecutive start failures
const START_FAILURE_POPUP_THRESHOLD = 3;

// At most one restart prompt per this interval
const WORKER_UNAVAILABLE_NOTIFY_INTERVAL_MS = 10 * 60 * 1000;

let lastNotifiedAt = 0;

export function notifyWorkerStartFailure(info: WorkerStartFailureInfo): void {
    // Background extraction is silent; only the user-facing worker warrants a
    // user-facing prompt.
    if (info.slotName !== 'hot') return;
    if (info.consecutiveFailures < START_FAILURE_POPUP_THRESHOLD) return;

    const now = Date.now();
    if (now - lastNotifiedAt < WORKER_UNAVAILABLE_NOTIFY_INTERVAL_MS) return;
    lastNotifiedAt = now;

    try {
        store.set(addPopupMessageAtom, {
            id: 'worker-unavailable',
            type: 'warning',
            title: "Beaver's PDF engine didn't start",
            text:
                'An internal Beaver process failed. As a result, Beaver cannot read ' +
                'your PDF files. Please restart Zotero. If the problem continues ' +
                'after restarting, please contact us at contact@beaverapp.ai.',
            expire: false,
        });
    } catch (error) {
        logger(`notifyWorkerStartFailure: failed to surface popup: ${error}`, 2);
    }
}
