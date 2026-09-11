/**
 * Wires the OCR background lane into the background dispatcher.
 *
 * Lives in the webpack bundle because the OcrExecutor needs the
 * Supabase-authenticated backend client. The dispatcher itself stays generic
 * and only knows the `JobExecutor` interface; this hook injects the OCR lane at
 * runtime via `registerExecutor`.
 *
 * Scope and entitlements are instance-owned. The local projection controls
 * registration of this renderer's executor.
 */

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
    libraryScopeInitializedAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { OcrExecutor } from '../../src/services/backgroundQueue/ocrExecutor';
import { logger } from '@beaver/agent-core/platform/logger';

/** Caps local OCR upload/download work; backend waits run slot-free. */
const OCR_LANE_MAX_IN_FLIGHT = 3;

export function useOcrLane(): void {
    const libraryScopeInitialized = useAtomValue(libraryScopeInitializedAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    // A stable value prevents equivalent profile refreshes from cycling the
    // lane, while still reacting immediately when access scope really changes.
    const libraryScopeKey = libraryScopeInitialized
        ? [...searchableLibraryIds].sort((a, b) => a - b).join(',')
        : null;

    // Register the OCR executor on the dispatcher. The background extractor is
    // created during esbuild startup, but the exact ordering vs the webpack
    // mount can vary (and it survives window reloads), so retry until present.
    useEffect(() => {
        if (libraryScopeKey === null) return;

        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        const executor = new OcrExecutor();

        const tryRegister = (): boolean => {
            const extractor = Zotero.Beaver?.backgroundExtractor;
            if (!extractor) return false;
            try {
                extractor.registerExecutor(executor, {
                    maxInFlight: OCR_LANE_MAX_IN_FLIGHT,
                });
                logger('useOcrLane: registered document_ocr lane', 3);
            } catch (error) {
                logger(`useOcrLane: registerExecutor failed: ${error}`, 1);
            }
            return true;
        };

        if (!tryRegister()) {
            timer = setInterval(() => {
                if (cancelled) return;
                if (tryRegister() && timer) {
                    clearInterval(timer);
                    timer = null;
                }
            }, 1_000);
        }

        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
            Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
                executor.jobType,
                executor,
            );
        };
    }, [libraryScopeKey]);

}
