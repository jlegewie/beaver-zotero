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
import { createSentenceFixture } from '../utils/extractionFixtures';
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
                case 'create-or-update-sentence-fixture': {
                    const r = await createSentenceFixture();
                    logger(`[ReaderVisualizer] create-or-update-sentence-fixture: ${r.message}`);
                    if (!r.ok) Zotero.alert(Zotero.getMainWindow(), 'Beaver Sentence Test', r.message);
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
 * Build a `beaver-extract fixture capture --update …` command targeting the
 * current reader page and copy it to the clipboard. The dev pastes it into a
 * terminal at the repo root to capture/refresh a fixture under
 * `tests/fixtures/pdfs/extract-public/`.
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

    const id = `${item.key}__p${pageIndex}`;
    // Always target the private (gitignored) corpus so reader-driven
    // captures don't accidentally land in the committed public fixture set.
    const parts = [
        'npm run beaver-extract --',
        'fixture capture',
        shellQuote(filePath),
        `--id ${id}`,
        `--pages ${pageIndex}`,
        '--root tests/fixtures/pdfs/extract',
        '--preview',
    ];
    if (language) parts.push(`--language ${shellQuote(language)}`);
    parts.push('--update');
    const command = parts.join(' ');

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
