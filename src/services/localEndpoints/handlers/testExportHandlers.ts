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
