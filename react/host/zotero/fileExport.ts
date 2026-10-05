import type { AgentRun } from '@beaver/agent-core/agents/types';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { ExportSource } from '@beaver/agent-export/types';
import type { FileExportContent, FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import { buildNoteExportSource, buildResponseExportSource } from '../../utils/exportSource';
import { getWindowRuntime } from '../../runtime/windowRuntime';
import { store } from '../../store';

/**
 * Hand a source to the plugin-realm exporter, which asks where to save
 * (parented to this window), formats citations in the citation style
 * preference, and writes the file.
 */
async function saveExport(source: ExportSource, format: FileExportFormat, windowId: string): Promise<FileExportResult> {
    const result = await Zotero.Beaver.exporter.run({ source, format }, { windowId });
    if (result.status !== 'saved') return { status: 'canceled' };
    return {
        status: 'saved',
        path: result.path,
        fileName: PathUtils.filename(result.path),
        warnings: result.warnings.map(warning => warning.message),
    };
}

/** Export a response (its resume chain) to a file. */
async function exportResponseToFile(request: {
    runs: AgentRun[];
    format: FileExportFormat;
    content: FileExportContent;
}): Promise<FileExportResult> {
    const windowId = getWindowRuntime().id;
    const source = await buildResponseExportSource(request.runs, request.content);
    return saveExport(source, request.format, windowId);
}

/**
 * Export a note the agent wrote (`create_note`) to a file, as the agent wrote
 * it. Interaction-time: reads the run from this window's thread.
 */
export async function exportNoteToFile(request: {
    runId: string;
    toolCallId: string;
    format: FileExportFormat;
}): Promise<FileExportResult> {
    const windowId = getWindowRuntime().id;
    const run = store.get(allRunsAtom).find(candidate => candidate.id === request.runId);
    const source = run ? await buildNoteExportSource(run, request.toolCallId) : null;
    if (!source) throw new Error('The note is no longer in this chat.');
    return saveExport(source, request.format, windowId);
}

export function revealExportedFile(path: string): void {
    Zotero.Beaver.exporter.reveal(path);
}

/** Zotero implementation of the file-export methods of the document export slice. */
export const zoteroFileExport = {
    exportResponseToFile,
    revealExportedFile,
};
