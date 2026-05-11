/**
 * Hook that listens for "readerVisualizerAction" events dispatched from the
 * esbuild bundle's reader integration (dev-only menu items) and runs the
 * corresponding extraction visualizer on the active reader.
 *
 * Dev-only: the dispatcher itself is gated behind `process.env.NODE_ENV ===
 * 'development'`, so this handler is effectively inert in production builds.
 */

import { useEventSubscription } from './useEventSubscription';
import {
    visualizeCurrentPageColumns,
    visualizeCurrentPageLines,
    visualizeCurrentPageParagraphs,
    visualizeCurrentPageSentences,
    clearVisualizationAnnotations,
    resolveActiveReaderContext,
} from '../utils/extractionVisualizer';
import { copyToClipboard } from '../utils/clipboard';
import { getItemLanguage } from '../../src/utils/zoteroUtils';
import { logger } from '../../src/utils/logger';

export function useReaderVisualizerActionHandler() {
    useEventSubscription('readerVisualizerAction', async (detail) => {
        if (process.env.NODE_ENV !== 'development') return;

        try {
            switch (detail.action) {
                case 'columns': {
                    const r = await visualizeCurrentPageColumns();
                    logger(`[ReaderVisualizer] columns: ${r.message}`);
                    return;
                }
                case 'lines': {
                    const r = await visualizeCurrentPageLines();
                    logger(`[ReaderVisualizer] lines: ${r.message}`);
                    return;
                }
                case 'paragraphs': {
                    const r = await visualizeCurrentPageParagraphs();
                    logger(`[ReaderVisualizer] paragraphs: ${r.message}`);
                    return;
                }
                case 'sentences': {
                    const r = await visualizeCurrentPageSentences();
                    logger(`[ReaderVisualizer] sentences: ${r.message}`);
                    return;
                }
                case 'clear': {
                    await clearVisualizationAnnotations();
                    logger('[ReaderVisualizer] cleared');
                    return;
                }
                case 'copy-fixture-capture-command': {
                    const r = await copyFixtureCaptureCommand();
                    logger(`[ReaderVisualizer] copy-fixture-capture-command: ${r.message}`);
                    // Zotero.alert(Zotero.getMainWindow(), 'Beaver Extract Fixture', r.message);
                    return;
                }
            }
        } catch (error) {
            logger(`useReaderVisualizerActionHandler: Error: ${error}`, 1);
        }
    }, []);
}

/**
 * Build a combined `beaver-extract fixture capture --update …` (page-scoped)
 * and `beaver-extract ocr-fixture capture --update …` (document-wide)
 * command targeting the current reader page and copy them to the clipboard.
 *
 * Both target the private corpus and reuse the same `_shared/<sha>.pdf`
 * — `ensureSharedPdf` is a no-op on the second command, so the PDF binary
 * is not duplicated on disk.
 */
async function copyFixtureCaptureCommand(): Promise<{ ok: boolean; message: string }> {
    const ctx = await resolveActiveReaderContext();
    if ('error' in ctx) return { ok: false, message: ctx.error };
    const { item, filePath, pageIndex } = ctx;

    let language: string | null = null;
    try {
        language = await getItemLanguage(item.libraryID, item.key);
    } catch {
        // Best effort — language is optional on the CLI flag.
    }

    const PRIVATE_ROOT = 'tests/fixtures/pdfs/extract';

    // 1) Extract fixture — page-scoped, id `paperKey__pN`.
    const extractId = `${item.key}__p${pageIndex}`;
    const extractParts = [
        'npm run beaver-extract --',
        'fixture capture',
        shellQuote(filePath),
        `--id ${extractId}`,
        `--pages ${pageIndex}`,
        `--root ${PRIVATE_ROOT}`,
        '--preview',
    ];
    if (language) extractParts.push(`--language ${shellQuote(language)}`);
    extractParts.push('--update');
    const extractCmd = extractParts.join(' ');

    // 2) OCR fixture — document-wide, id `paperKey` (no `__pN`). Reuses
    //    `_shared/<sha>.pdf` written by the extract capture above.
    const ocrParts = [
        'npm run beaver-extract --',
        'ocr-fixture capture',
        shellQuote(filePath),
        `--id ${item.key}`,
        `--root ${PRIVATE_ROOT}`,
        '--update',
    ];
    const ocrCmd = ocrParts.join(' ');

    const command = `${extractCmd} \\\n  && ${ocrCmd}`;

    const ok = await copyToClipboard(command);
    if (!ok) {
        return {
            ok: false,
            message: `Failed to copy commands. Run manually:\n\n${command}`,
        };
    }
    return {
        ok: true,
        message: `Copied to clipboard. Run from the repo root:\n\n${command}`,
    };
}

function shellQuote(s: string): string {
    // POSIX-safe single-quoting: close, escape embedded single-quote, reopen.
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
