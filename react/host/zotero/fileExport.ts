import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { FileExportContent, FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import { buildResponseExportSource } from '../../utils/exportSource';
import { getWindowRuntime } from '../../runtime/windowRuntime';

/**
 * Export a response to a file through the plugin-realm exporter, which asks
 * where to save (parented to this window), formats citations in the citation
 * style preference, and writes the file.
 */
async function exportResponseToFile(request: {
    runs: AgentRun[];
    format: FileExportFormat;
    content: FileExportContent;
}): Promise<FileExportResult> {
    const windowId = getWindowRuntime().id;
    const source = await buildResponseExportSource(request.runs, request.content);
    const result = await Zotero.Beaver.exporter.run({ source, format: request.format }, { windowId });
    if (result.status !== 'saved') return { status: 'canceled' };
    return {
        status: 'saved',
        path: result.path,
        fileName: PathUtils.filename(result.path),
        warnings: result.warnings.map(warning => warning.message),
    };
}

function revealExportedFile(path: string): void {
    Zotero.Beaver.exporter.reveal(path);
}

/** Zotero implementation of the file-export methods of the document export slice. */
export const zoteroFileExport = {
    exportResponseToFile,
    revealExportedFile,
};
