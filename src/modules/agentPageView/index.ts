/**
 * "Visualize (Schema N)" for the PDF reader, a development tool: shows what the
 * Beaver agent sees on each page and what it can cite — table, figure and
 * equation regions, table rows, sentences, and items cited as a whole.
 *
 * Every run extracts the document afresh in the requested PDF schema version,
 * with the arguments production extraction uses, so changes to the extractor
 * show up immediately. The document cache is neither read nor written, and
 * nothing leaves the device.
 *
 * Lives in the esbuild bundle; one overlay per reader, released when the
 * reader's PDF view unloads or the plugin shuts down.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { getMuPDFWorkerClient } from '../../beaver-extract';
import { createAbortController } from '../../utils/abortController';
import { AgentPageOverlay } from './agentPageOverlay';
import { buildAgentViewPage, totalAgentViewCounts, type AgentViewPageCounts } from './agentPageViewModel';

interface ActiveView {
    schemaVersion: string;
    overlay: AgentPageOverlay;
    release: () => void;
}

const activeViews = new Map<string, ActiveView>();

function readerKey(reader: any): string | null {
    return typeof reader?._instanceID === 'string' ? reader._instanceID : null;
}

function pdfViewWindow(reader: any): Window | null {
    const win = reader?._internalReader?._primaryView?._iframeWindow;
    return win?.document?.getElementById('viewer') ? win : null;
}

/** The schema version the reader is currently visualizing, or `null`. */
export function activeAgentPageViewSchema(reader: any): string | null {
    const key = readerKey(reader);
    return (key && activeViews.get(key)?.schemaVersion) || null;
}

/** Remove the agent view from a reader. */
export function hideAgentPageView(reader: any): void {
    const key = readerKey(reader);
    if (key) disposeView(key);
}

/** Remove every agent view (plugin shutdown). */
export function disposeAllAgentPageViews(): void {
    for (const key of [...activeViews.keys()]) disposeView(key);
}

function disposeView(key: string): void {
    const view = activeViews.get(key);
    if (!view) return;
    activeViews.delete(key);
    view.release();
    view.overlay.dispose();
}

function summarize(counts: AgentViewPageCounts, pageCount: number): string {
    const parts = [
        `${counts.sentences} sentences`,
        `${counts.items} whole items`,
        `${counts.tables} tables (${counts.tableRows} rows)`,
        `${counts.figures} figures`,
        `${counts.equations} equations`,
    ];
    const lines = [`${pageCount} pages: ${parts.join(', ')}.`];
    if (counts.unlocatedSentences > 0) {
        lines.push(`${counts.unlocatedSentences} citable sentences have no position and aren't drawn.`);
    }
    return lines.join('\n');
}

/** Extract the reader's PDF in `schemaVersion` and show what the agent sees. */
export async function showAgentPageView(reader: any, schemaVersion: string): Promise<void> {
    const key = readerKey(reader);
    const win = pdfViewWindow(reader);
    const hostWin: Window | undefined = reader._window;
    if (!key || !win || !hostWin || reader.type !== 'pdf') return;

    disposeView(key);
    const abort = createAbortController();
    const overlay = new AgentPageOverlay(
        win,
        hostWin,
        `What Beaver sees (schema ${schemaVersion})`,
        () => disposeView(key),
    );
    const onUnload = () => disposeView(key);
    win.addEventListener('unload', onUnload, { once: true });
    activeViews.set(key, {
        schemaVersion,
        overlay,
        release: () => {
            abort.abort();
            try {
                win.removeEventListener('unload', onUnload);
            } catch {
                // The view is already gone.
            }
        },
    });
    const isCurrent = () => activeViews.get(key)?.overlay === overlay;

    const item = Zotero.Items.get(reader.itemID);
    if (!item) {
        overlay.setStatus('Could not find this attachment.', 'error');
        return;
    }
    // An excluded library is not readable by Beaver at all, so there is nothing
    // to show — and extracting it would be a Beaver operation on excluded data.
    if (!Zotero.Beaver?.libraryScopeInitialized) {
        overlay.setStatus('Sign in to Beaver to see what it can read.', 'error');
        return;
    }
    if (!(Zotero.Beaver.searchableLibraryIds ?? []).includes(item.libraryID)) {
        overlay.setStatus('This library is excluded from Beaver, so Beaver cannot read this document.', 'error');
        return;
    }

    overlay.setStatus(`Extracting the document (schema ${schemaVersion})…`);
    let extracted;
    try {
        const filePath = await item.getFilePathAsync();
        if (!filePath) throw new Error('The PDF file is not available on this device.');
        const pdfData = await IOUtils.read(filePath);
        if (!isCurrent()) return;
        extracted = await getMuPDFWorkerClient('hot').extract(pdfData, {
            mode: 'structured',
            settings: { checkTextLayer: true },
            schemaVersion,
        }, abort.signal);
    } catch (error) {
        if (!isCurrent()) return;
        logger(`agentPageView: extraction failed: ${error}`, 1);
        overlay.setStatus(`Extraction failed: ${error instanceof Error ? error.message : error}`, 'error');
        return;
    }
    if (!isCurrent()) return;
    if (extracted.mode !== 'structured') {
        overlay.setStatus('The extractor did not return a structured document.', 'error');
        return;
    }

    const pages = extracted.document.pages.map(buildAgentViewPage);
    overlay.setPages(pages);
    overlay.setStatus(summarize(totalAgentViewCounts(pages), extracted.document.pageCount));
}
