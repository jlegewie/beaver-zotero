/**
 * `InstancePdfJobs` wired to Zotero. Plugin realm only (reads `Zotero.Beaver`).
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { PDF_JOB_CHANGED_EVENT } from '@beaver/agent-core/protocol/jobCallProtocol';
import { cancelTask } from '../../utils/backgroundTasks';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { getZoteroUserIdentifier } from '../../utils/zoteroInstanceIdentity';
import { isLibrarySearchable } from '../agentDataProvider/utils';
import { filterPdfAttachments } from './pdfFetch';
import { InstancePdfJobs } from './pdfJobs';

export function createInstancePdfJobs(): InstancePdfJobs {
    return new InstancePdfJobs({
        jobCalls: () => Zotero.Beaver?.jobCalls,
        newId: () => crypto.randomUUID(),
        device: () => {
            try {
                const { localUserKey, deviceName } = getZoteroUserIdentifier();
                return { device_key: localUserKey, ...(deviceName ? { device_name: deviceName } : {}) };
            } catch {
                return {};
            }
        },
        signedIn: () => !!Zotero.Beaver?.account?.getSnapshot().session?.user.id,
        librarySendable: (libraryId) => isLibrarySearchable(libraryId),
        libraryRef: (libraryId) => libraryRefForLibraryID(libraryId),
        cancelFetch: (_libraryId, _zoteroKey, taskId) => {
            if (taskId) cancelTask(taskId);
        },
        currentPdf: async (libraryId, zoteroKey) => {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (!item || item.deleted) return null;
            const pdfs = await filterPdfAttachments(await item.getAttachments());
            return pdfs[0]?.key ?? null;
        },
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
        log: (message) => logger(message, 1),
        publish: (snapshot) => Zotero.Beaver?.runtime.publish(PDF_JOB_CHANGED_EVENT, snapshot),
    });
}
