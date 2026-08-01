import { useCallback } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { attachExternalFile } from '../../src/services/externalFiles';
import type { ExternalFileRecord } from '../../src/services/database';
import {
    addExternalFilesToCurrentMessageAtom,
    composerResetTokenAtom,
    pendingAttachmentCountAtom,
} from '../atoms/messageComposition';
import { selectedModelAtom } from '../atoms/models';
import { requestPlusToolsAtom } from '../atoms/ui';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { getPref } from '../../src/utils/prefs';
import { logger } from '../../src/utils/logger';

/** A file to attach: a path (file picker, clipboard) or an `nsIFile` (drop). */
export type ExternalFileSource = string | { path: string };

export interface AttachExternalFilesOptions {
    /**
     * Reports a rejected file (unsupported type, too large, needs vision, over
     * the per-message limit). Defaults to a popup message.
     */
    onReject?: (message: string) => void;
}

export interface AttachExternalFilesResult {
    attached: ExternalFileRecord[];
    /** Number of files rejected; every one was reported through `onReject`. */
    rejectedCount: number;
    /** True when the composition was replaced mid-attach, so the files were dropped. */
    discarded?: boolean;
}

function defaultMaxFiles(): number {
    return (getPref('maxAddAttachmentToMessage') as number) || 10;
}

/**
 * Runs `work` while the composer counts an attachment as in flight, holding
 * sending until it finishes (see `pendingAttachmentCountAtom`). Callers that
 * prepare a file before attaching it wrap the whole operation, so the hold
 * spans that too.
 */
export function useHoldSendForAttachment() {
    const setPendingAttachmentCount = useSetAtom(pendingAttachmentCountAtom);
    return useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
        setPendingAttachmentCount((count) => count + 1);
        try {
            return await work();
        } finally {
            setPendingAttachmentCount((count) => count - 1);
        }
    }, [setPendingAttachmentCount]);
}

/**
 * Attach files from disk to the current message as external files. Shared by
 * drag-and-drop, the file picker, and paste, so they agree on the per-message
 * limit, the model-capability gating, and how rejections are reported.
 */
export function useAttachExternalFiles() {
    const addExternalFilesToCurrentMessage = useSetAtom(addExternalFilesToCurrentMessageAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const requestPlusTools = useAtomValue(requestPlusToolsAtom);
    const holdSendForAttachment = useHoldSendForAttachment();
    const store = useStore();

    return useCallback(
        async (
            sources: ExternalFileSource[],
            options: AttachExternalFilesOptions = {},
        ): Promise<AttachExternalFilesResult> => {
            const reject = options.onReject
                ?? ((message: string) => addPopupMessage({
                    type: 'warning',
                    title: 'File not added',
                    text: message,
                    expire: true,
                }));

            if (sources.length === 0) {
                return { attached: [], rejectedCount: 0 };
            }

            const maxFiles = defaultMaxFiles();
            if (sources.length > maxFiles) {
                reject(`You can add up to ${maxFiles} files at a time.`);
                return { attached: [], rejectedCount: sources.length };
            }

            // Images need a vision-capable model and scanned PDFs need vision
            // or the plus tools, so both are rejected here rather than failing
            // later in the run.
            const supportsVision = selectedModel?.supports_vision === true;
            const attachOptions = {
                supportsVision,
                canHandleOCRLocally: supportsVision || Boolean(requestPlusTools),
            };

            // Attaching is asynchronous, so the composition these files belong
            // to can be replaced mid-flight. Remember which one they were
            // staged for and check again before adding them.
            const composerToken = store.get(composerResetTokenAtom);

            return holdSendForAttachment(async () => {
                const attached: ExternalFileRecord[] = [];
                let rejectedCount = 0;
                for (const source of sources) {
                    const result = await attachExternalFile(source, attachOptions);
                    if (result.status === 'attached') {
                        attached.push(result.record);
                    } else {
                        rejectedCount++;
                        reject(result.message);
                    }
                }
                if (attached.length > 0) {
                    if (store.get(composerResetTokenAtom) !== composerToken) {
                        // Adding them now would move files staged for the
                        // previous message onto the next one.
                        logger(
                            `useAttachExternalFiles: composer was reset while attaching; `
                            + `dropped ${attached.length} file(s)`,
                            2,
                        );
                        return { attached: [], rejectedCount, discarded: true };
                    }
                    addExternalFilesToCurrentMessage(attached);
                }
                return { attached, rejectedCount };
            });
        },
        [
            addExternalFilesToCurrentMessage,
            addPopupMessage,
            selectedModel,
            requestPlusTools,
            holdSendForAttachment,
            store,
        ],
    );
}
