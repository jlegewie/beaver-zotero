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
    visualizeCurrentPageItems,
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
                case 'items': {
                    const r = await visualizeCurrentPageItems();
                    logger(`[ReaderVisualizer] items: ${r.message}`);
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
                case 'copy-extract-fixture-command': {
                    const r = await copyExtractFixtureCommand();
                    logger(`[ReaderVisualizer] copy-extract-fixture-command: ${r.message}`);
                    return;
                }
                case 'copy-ocr-fixture-command': {
                    const r = await copyOcrFixtureCommand();
                    logger(`[ReaderVisualizer] copy-ocr-fixture-command: ${r.message}`);
                    return;
                }
            }
        } catch (error) {
            logger(`useReaderVisualizerActionHandler: Error: ${error}`, 1);
        }
    }, []);
}

/**
 * Build a `beaver-extract fixture capture --update …` command (page-scoped,
 * id `paperKey__pN`) targeting the current reader page and copy it to the
 * clipboard.
 */
async function copyExtractFixtureCommand(): Promise<{ ok: boolean; message: string }> {
    const ctx = await resolveActiveReaderContext();
    if ('error' in ctx) return { ok: false, message: ctx.error };
    const { item, filePath, pageIndex } = ctx;

    let language: string | null = null;
    try {
        language = await getItemLanguage(item.libraryID, item.key);
    } catch {
        // Best effort — language is optional on the CLI flag.
    }

    const extractId = `${item.key}__p${pageIndex}`;
    const parts = [
        'npm run beaver-extract --',
        'fixture capture',
        shellQuote(filePath),
        `--id ${extractId}`,
        `--pages ${pageIndex}`,
        '--preview',
    ];
    if (language) parts.push(`--language ${shellQuote(language)}`);
    parts.push('--update');
    const command = parts.join(' ');

    return copyCommand(command);
}

/**
 * Build a `beaver-extract ocr-fixture capture --update …` command
 * (document-wide, id `paperKey`) for the current reader item and copy it to
 * the clipboard. Reuses `_shared/<sha>.pdf` when an extract fixture has
 * already been captured for the same PDF.
 */
async function copyOcrFixtureCommand(): Promise<{ ok: boolean; message: string }> {
    const ctx = await resolveActiveReaderContext();
    if ('error' in ctx) return { ok: false, message: ctx.error };
    const { item, filePath } = ctx;

    // --root is intentionally omitted; see copyExtractFixtureCommand above.
    const parts = [
        'npm run beaver-extract --',
        'ocr-fixture capture',
        shellQuote(filePath),
        `--id ${item.key}`,
        '--update',
    ];
    const command = parts.join(' ');

    return copyCommand(command);
}

async function copyCommand(command: string): Promise<{ ok: boolean; message: string }> {
    const ok = await copyToClipboard(command);
    if (!ok) {
        return {
            ok: false,
            message: `Failed to copy command. Run manually:\n\n${command}`,
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
