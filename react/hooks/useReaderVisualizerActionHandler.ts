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
    visualizeCurrentPageSentences,
    clearVisualizationAnnotations,
    resolveActiveReaderContext,
} from '../utils/extractionVisualizer';
import {
    visualizeEpubItems,
    visualizeEpubSentences,
} from '../utils/epubVisualizer/epubExtractionVisualizer';
import { copyToClipboard } from '../utils/clipboard';
import type { ZoteroReader } from '../utils/annotationUtils';
import { getItemLanguage } from '../../src/utils/zoteroUtils';
import { logger } from '@beaver/agent-core/platform/logger';

export function useReaderVisualizerActionHandler() {
    useEventSubscription('readerVisualizerAction', async (detail) => {
        if (process.env.NODE_ENV !== 'development' || !detail.readerInstanceID) return;

        const reader = (Zotero.Reader as any)._readers.find((candidate: any) =>
            candidate._instanceID === detail.readerInstanceID) as ZoteroReader | undefined;
        if (!reader || (reader as any)._window?.closed) return;

        try {
            switch (detail.action) {
                case 'columns': {
                    const r = await visualizeCurrentPageColumns({ reader });
                    logger(`[ReaderVisualizer] columns: ${r.message}`);
                    return;
                }
                case 'columns-graphics': {
                    const r = await visualizeCurrentPageColumns({ reader, graphicsLayerMode: 'on' });
                    logger(`[ReaderVisualizer] columns-graphics: ${r.message}`);
                    return;
                }
                case 'lines': {
                    const r = await visualizeCurrentPageLines({ reader });
                    logger(`[ReaderVisualizer] lines: ${r.message}`);
                    return;
                }
                case 'items': {
                    const r = await visualizeItemsForActiveReader(reader);
                    logger(`[ReaderVisualizer] items: ${r.message}`);
                    return;
                }
                case 'items-graphics': {
                    const r = await visualizeCurrentPageItems({ reader, graphicsLayerMode: 'on' });
                    logger(`[ReaderVisualizer] items-graphics: ${r.message}`);
                    return;
                }
                case 'sentences': {
                    const r = await visualizeSentencesForActiveReader(reader);
                    logger(`[ReaderVisualizer] sentences: ${r.message}`);
                    return;
                }
                case 'sentences-graphics': {
                    const r = await visualizeCurrentPageSentences({ reader, graphicsLayerMode: 'on' });
                    logger(`[ReaderVisualizer] sentences-graphics: ${r.message}`);
                    return;
                }
                case 'clear': {
                    await clearVisualizationAnnotations(reader);
                    logger('[ReaderVisualizer] cleared');
                    return;
                }
                case 'copy-extract-fixture-command': {
                    const r = await copyExtractFixtureCommand(reader);
                    logger(`[ReaderVisualizer] copy-extract-fixture-command: ${r.message}`);
                    return;
                }
                case 'copy-ocr-fixture-command': {
                    const r = await copyOcrFixtureCommand(reader);
                    logger(`[ReaderVisualizer] copy-ocr-fixture-command: ${r.message}`);
                    return;
                }
            }
        } catch (error) {
            logger(`useReaderVisualizerActionHandler: Error: ${error}`, 1);
        }
    }, []);
}

async function visualizeItemsForActiveReader(reader: ZoteroReader): Promise<{ success: boolean; message: string }> {
    if (reader?.type === 'epub') return visualizeEpubItems(reader);
    return visualizeCurrentPageItems({ reader });
}

async function visualizeSentencesForActiveReader(reader: ZoteroReader): Promise<{ success: boolean; message: string }> {
    if (reader?.type === 'epub') return visualizeEpubSentences(reader);
    return visualizeCurrentPageSentences({ reader });
}

/**
 * Build a `beaver-extract fixture capture --update …` command (page-scoped,
 * id `paperKey__pN`) targeting the current reader page and copy it to the
 * clipboard.
 */
async function copyExtractFixtureCommand(reader: ZoteroReader): Promise<{ ok: boolean; message: string }> {
    const ctx = await resolveActiveReaderContext(reader);
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
async function copyOcrFixtureCommand(reader: ZoteroReader): Promise<{ ok: boolean; message: string }> {
    const ctx = await resolveActiveReaderContext(reader);
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
