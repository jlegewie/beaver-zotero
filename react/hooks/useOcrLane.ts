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
import { hasOcrAccessAtom } from '../atoms/profile';
import { OcrExecutor } from '../../src/services/backgroundQueue/ocrExecutor';
import { logger } from '../../src/utils/logger';

/** OCR jobs are IO-bound (upload/poll/download); run a few concurrently. */
const OCR_LANE_MAX_IN_FLIGHT = 3;

export function useOcrLane(): void {
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);

    // Register the OCR executor on the dispatcher. The background extractor is
    // created during esbuild startup, but the exact ordering vs the webpack
    // mount can vary (and it survives window reloads), so retry until present.
    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;

        const tryRegister = (): boolean => {
            const extractor = Zotero.Beaver?.backgroundExtractor;
            if (!extractor) return false;
            try {
                extractor.registerExecutor(new OcrExecutor(), {
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
        };
    }, []);

    // Mirror the entitlement into the esbuild-readable global used by the
    // enqueue gate.
    useEffect(() => {
        if (Zotero.Beaver) {
            (Zotero.Beaver as { hasOcrAccess?: boolean }).hasOcrAccess = hasOcrAccess;
        }
    }, [hasOcrAccess]);
}
