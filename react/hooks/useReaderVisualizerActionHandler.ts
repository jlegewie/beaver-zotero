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
} from '../utils/extractionVisualizer';
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
            }
        } catch (error) {
            logger(`useReaderVisualizerActionHandler: Error: ${error}`, 1);
        }
    }, []);
}
