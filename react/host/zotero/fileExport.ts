import type { AgentRun } from '@beaver/agent-core/agents/types';
import { allRunsAtom } from '@beaver/agent-core/run-state/atoms';
import type { ExportSource } from '@beaver/agent-export/types';
import type { FileExportContent, FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import { buildNoteExportSource, buildResponseExportSource, buildThreadExportSource } from '../../utils/exportSource';
import { getWindowRuntime } from '../../runtime/windowRuntime';
import { store } from '../../store';
import type { OpenNoteTarget } from './components/reviewChangeRows';

type ExporterResult = Awaited<ReturnType<typeof Zotero.Beaver.exporter.run>>;

/**
 * Hand a source to the plugin-realm exporter, which asks where to save
 * (parented to this window), formats citations in the citation style
 * preference, and writes the file.
 */
async function saveExport(source: ExportSource, format: FileExportFormat, windowId: string): Promise<FileExportResult> {
    return fileExportResult(await Zotero.Beaver.exporter.run({ source, format }, { windowId }));
}

/** What the exporter saved, as the export UI reports it. */
function fileExportResult(result: ExporterResult, extraWarnings: string[] = []): FileExportResult {
    if (result.status !== 'saved') return { status: 'canceled' };
    const folder = PathUtils.parent(result.path);
    return {
        status: 'saved',
        path: result.path,
        fileName: PathUtils.filename(result.path),
        folderName: folder ? PathUtils.filename(folder) || folder : '',
        // A LaTeX export also writes its .bib file.
        companionFileNames: result.files.filter(file => file !== result.path).map(file => PathUtils.filename(file)),
        warnings: [...extraWarnings, ...result.warnings.map(warning => warning.message)],
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

/** Export a whole thread, with its prompts and tool activity, to a file. */
async function exportThreadToFile(request: {
    runs: AgentRun[];
    format: FileExportFormat;
}): Promise<FileExportResult> {
    const windowId = getWindowRuntime().id;
    const source = await buildThreadExportSource(request.runs);
    return saveExport(source, request.format, windowId);
}

/**
 * Export a note the agent wrote (`create_note`) to a file: the note as it is
 * now in Zotero, with any later edits by the agent or the user. When there is
 * no note to export — the action was not applied, was undone, or the note was
 * deleted — the note is exported as the agent wrote it, with a warning.
 * Interaction-time: reads the run from this window's thread.
 */
export async function exportNoteToFile(request: {
    runId: string;
    toolCallId: string;
    format: FileExportFormat;
    /** The created note, when the action is applied. */
    note?: OpenNoteTarget | null;
}): Promise<FileExportResult> {
    const windowId = getWindowRuntime().id;
    if (request.note?.zotero_key) {
        try {
            const result = await Zotero.Beaver.exporter.exportNote({
                note: {
                    key: request.note.zotero_key,
                    libraryRef: request.note.library_ref,
                    libraryID: request.note.library_id,
                },
                format: request.format,
            }, { windowId });
            return fileExportResult(result);
        } catch (error: any) {
            // A note deleted since it was created falls back to the version the agent wrote.
            if (error?.code !== 'note_not_found') throw error;
        }
    }
    const run = store.get(allRunsAtom).find(candidate => candidate.id === request.runId);
    const source = run ? await buildNoteExportSource(run, request.toolCallId) : null;
    if (!source) throw new Error('The note is no longer in this chat.');
    const fallbackWarning = request.note?.zotero_key
        ? 'The note is no longer in your library. Exported the version Beaver wrote.'
        : 'The note is not in your library. Exported the version Beaver wrote.';
    return fileExportResult(await Zotero.Beaver.exporter.run({ source, format: request.format }, { windowId }), [fallbackWarning]);
}

export function revealExportedFile(path: string): Promise<void> {
    return Zotero.Beaver.exporter.reveal(path);
}

export function openExportedFile(path: string): Promise<void> {
    return Zotero.Beaver.exporter.open(path);
}

/** Zotero implementation of the file-export methods of the document export slice. */
export const zoteroFileExport = {
    exportResponseToFile,
    exportThreadToFile,
    revealExportedFile,
    openExportedFile,
};
