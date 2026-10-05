import type { FileExportResult } from '@beaver/agent-ui/host/types';
import type { PopupMessage } from '../types/popupMessage';

type Notify = (message: Omit<PopupMessage, 'id'>) => void;

/**
 * Run a file export and tell the user how it went: a confirmation naming the
 * file (with any warnings, and a "Show File" button when the host can reveal
 * files), nothing when the save dialog was canceled, an error otherwise.
 */
export async function exportWithFeedback(
    exportFile: () => Promise<FileExportResult>,
    notify: Notify,
    reveal?: (path: string) => void,
): Promise<void> {
    try {
        const result = await exportFile();
        if (result.status !== 'saved') return;
        notify({
            type: 'info',
            title: 'Exported to Word',
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
