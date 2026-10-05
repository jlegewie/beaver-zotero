import type { FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import type { PopupMessage } from '../types/popupMessage';

type Notify = (message: Omit<PopupMessage, 'id'>) => void;

/** How a format is named to the user. */
export const FILE_EXPORT_FORMAT_NAMES: Record<FileExportFormat, string> = {
    docx: 'Word',
    pdf: 'PDF',
    markdown: 'Markdown',
    latex: 'LaTeX',
};

/** Menu entries for each export format, in menu order. */
export const FILE_EXPORT_MENU: Array<{ format: FileExportFormat; label: string }> = [
    { format: 'docx', label: 'Export to Word…' },
    { format: 'pdf', label: 'Export to PDF…' },
    { format: 'markdown', label: 'Export to Markdown…' },
    { format: 'latex', label: 'Export to LaTeX…' },
];

/**
 * Run a file export and tell the user how it went: a confirmation naming the
 * file (with any warnings, and a "Show File" button when the host can reveal
 * files), nothing when the save dialog was canceled, an error otherwise.
 */
export async function exportWithFeedback(
    format: FileExportFormat,
    exportFile: () => Promise<FileExportResult>,
    notify: Notify,
    reveal?: (path: string) => void,
): Promise<void> {
    try {
        const result = await exportFile();
        if (result.status !== 'saved') return;
        notify({
            type: 'info',
            title: `Exported to ${FILE_EXPORT_FORMAT_NAMES[format]}`,
            text: [result.fileName, ...result.warnings].join(' — '),
            ...(reveal ? { button: { text: 'Show File', onClick: () => reveal(result.path) } } : {}),
        });
    } catch (error: any) {
        notify({
            type: 'error',
            title: 'Could not export',
            text: error?.message || 'The export failed.',
        });
    }
}
