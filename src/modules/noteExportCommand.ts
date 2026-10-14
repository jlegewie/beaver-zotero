/**
 * Export a Zotero note from one of Zotero's own menus (the note editor's More
 * menu, the item tree's context menu): ask where to save, then say how it went
 * in a Zotero progress window.
 *
 * Lives in the esbuild bundle — must NOT import from react/store or Jotai.
 */

import type { ExportFormat } from '../services/export/instanceExport';
import type { ExportSurface } from '../services/export/exportTelemetry';
import { exportErrorMessage } from '../services/export/exportErrors';

/** Export formats in menu order, as the chat's export menus name them. */
export const NOTE_EXPORT_FORMATS: ReadonlyArray<{ format: ExportFormat; name: string }> = [
    { format: 'docx', name: 'Word' },
    { format: 'pdf', name: 'PDF' },
    { format: 'markdown', name: 'Markdown' },
    { format: 'latex', name: 'LaTeX' },
];

/**
 * Export the note, asking where to save, and say how it went. `html` is the
 * note as one editor shows it; without it, the latest content of any open
 * editor is exported.
 */
export async function exportNoteWithProgress(
    note: Zotero.Item,
    html: string | null,
    format: ExportFormat,
    name: string,
    win: Window,
    surface: ExportSurface,
): Promise<void> {
    try {
        const result = await addon.exporter.exportNote(
            { note: { key: note.key, libraryID: note.libraryID }, html: html ?? undefined, format },
            { window: win, surface },
        );
        if (result.status !== 'saved') return;
        const progress = new Zotero.ProgressWindow({ window: win.closed ? undefined : win, closeOnClick: true });
        progress.changeHeadline(`Exported to ${name}`);
        // The document, a LaTeX export's .bib file, and the folder of images
        // that Markdown and LaTeX exports write beside the document. Icons are
        // Zotero's item type icons.
        const [documentPath, ...others] = result.files;
        const bibliographies = others.filter(path => /\.bib$/i.test(path));
        const images = others.filter(path => !/\.bib$/i.test(path));
        for (const path of [documentPath, ...bibliographies]) {
            const line = new progress.ItemProgress(path === documentPath && format === 'pdf' ? 'attachmentPDF' : 'document', PathUtils.filename(path));
            line.setProgress(100);
        }
        if (images.length > 0) {
            const folder = PathUtils.filename(PathUtils.parent(images[0]) ?? '');
            const line = new progress.ItemProgress('attachmentImage', `${images.length} image${images.length === 1 ? '' : 's'} in ${folder}`);
            line.setProgress(100);
        }
        for (const warning of result.warnings) {
            progress.addDescription(warning.message);
        }
        progress.show();
        progress.startCloseTimer(result.warnings.length > 0 ? 10000 : 5000);
    } catch (error: any) {
        Zotero.logError(error);
        Services.prompt.alert((win.closed ? null : win) as any, 'Could not export', exportErrorMessage(error));
    }
}
