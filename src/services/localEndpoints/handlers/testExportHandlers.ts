/**
 * Dev-only `/beaver/test/export`: write an export file without the save dialog.
 *
 * With `source` (an `ExportSource`), exports it directly — no window or thread
 * needed, so tests can export hand-written markdown with any citations. Without
 * it, the request is forwarded to a window (`windowId`, default the main
 * window), which exports a response of its open thread (`runId`, default the
 * last run) or, with `scope: 'thread'`, the whole thread. Common fields:
 * `{ path, format?: 'docx' | 'pdf' | 'markdown' | 'latex', styleId?, locale?,
 * liveCitations?, linkItems?, includeHtml?, frontMatter?, citationPackage?,
 * standalone? }` (`includeHtml` returns the
 * HTML a PDF was printed from; `frontMatter` is Markdown's, `citationPackage`
 * and `standalone` LaTeX's).
 */

export async function handleTestExportHttpRequest(request: any): Promise<any> {
    if (typeof request?.path !== 'string' || !request.path) {
        return { error: 'path is required' };
    }
    if (request.source) {
        return Zotero.Beaver.exporter.run({
            source: request.source,
            format: request.format ?? 'docx',
            path: request.path,
            styleId: request.styleId,
            locale: request.locale,
            liveCitations: request.liveCitations,
            linkItems: request.linkItems,
            includeHtml: request.includeHtml,
            frontMatter: request.frontMatter,
            citationPackage: request.citationPackage,
            standalone: request.standalone,
        });
    }
    return Zotero.Beaver.runtime.dispatchWindowCommand('/beaver/test/export', request);
}

/**
 * Dev-only `/beaver/test/export-note`: export a Zotero note to a file without
 * the save dialog. Request: `{ path, note: { key, libraryRef? | libraryID? }
 * | html (with title?), format?, styleId?, locale?, liveCitations?,
 * linkItems?, colors?, includeHtml?, frontMatter?, citationPackage?,
 * standalone? }`. `html` exports the given note HTML, so tests need no note
 * in the library.
 */
export async function handleTestExportNoteHttpRequest(request: any): Promise<any> {
    if (typeof request?.path !== 'string' || !request.path) {
        return { error: 'path is required' };
    }
    if (!request.note && typeof request.html !== 'string') {
        return { error: 'note or html is required' };
    }
    try {
        return await Zotero.Beaver.exporter.exportNote({
            note: request.note,
            html: request.html,
            title: request.title,
            format: request.format ?? 'docx',
            path: request.path,
            styleId: request.styleId,
            locale: request.locale,
            liveCitations: request.liveCitations,
            linkItems: request.linkItems,
            colors: request.colors,
            includeHtml: request.includeHtml,
            frontMatter: request.frontMatter,
            citationPackage: request.citationPackage,
            standalone: request.standalone,
        });
    } catch (error: any) {
        return { error: typeof error?.code === 'string' ? error.code : 'export_failed', message: String(error?.message ?? error) };
    }
}
