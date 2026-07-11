/**
 * Wires the OCR background lane into the (esbuild) background dispatcher and
 * keeps the OCR entitlement mirror in sync.
 *
 * Lives in the webpack bundle because the OcrExecutor needs the
 * Supabase-authenticated backend client. The dispatcher itself stays generic
 * and only knows the `JobExecutor` interface; this hook injects the OCR lane at
 * runtime via `registerExecutor`.
 */

import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
    hasOcrAccessAtom,
    libraryScopeInitializedAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { OcrExecutor } from '../../src/services/backgroundQueue/ocrExecutor';
import { logger } from '../../src/utils/logger';

/** Caps local OCR upload/download work; backend waits run slot-free. */
const OCR_LANE_MAX_IN_FLIGHT = 3;

export function useOcrLane(): void {
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const libraryScopeInitialized = useAtomValue(libraryScopeInitializedAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    // A stable value prevents equivalent profile refreshes from cycling the
    // lane, while still reacting immediately when access scope really changes.
    const libraryScopeKey = libraryScopeInitialized
        ? [...searchableLibraryIds].sort((a, b) => a - b).join(',')
        : null;

    // Mirror the access-control boundary for esbuild-side producers. They
    // cannot import the webpack Jotai store, so this is their only source of
    // searchable library scope.
    useEffect(() => {
        if (!Zotero.Beaver) return;
        (Zotero.Beaver as {
            searchableLibraryIds?: number[];
            libraryScopeInitialized?: boolean;
        }).searchableLibraryIds = [...searchableLibraryIds];
        (Zotero.Beaver as { libraryScopeInitialized?: boolean })
            .libraryScopeInitialized = libraryScopeInitialized;
        Zotero.Beaver.processingReconciler?.notify();
    }, [libraryScopeInitialized, libraryScopeKey]);

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

    // Mirror the entitlement into the esbuild-readable global used by the
    // enqueue gate.
    useEffect(() => {
        if (Zotero.Beaver) {
            (Zotero.Beaver as { hasOcrAccess?: boolean }).hasOcrAccess = hasOcrAccess;
        }
        Zotero.Beaver?.processingReconciler?.notify();
    }, [hasOcrAccess]);
}
