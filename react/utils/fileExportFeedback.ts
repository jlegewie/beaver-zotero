import type { FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { DocIcon, MarkdownIcon, PdfIcon, TexIcon } from '@beaver/agent-ui/icons';
import type { PopupMessage } from '../types/popupMessage';

type Notify = (message: Omit<PopupMessage, 'id'>) => void;

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

/** How each export format is named and drawn, in menu order. */
export const FILE_EXPORT_FORMATS: Array<{
    format: FileExportFormat;
    /** The format as named to the user. */
    name: string;
    icon: IconComponent;
    /** Tag colour hue of the format's icon tile (see `agent-ui-tokens.css`). */
    hue: 'blue' | 'red' | 'purple' | 'green';
}> = [
    { format: 'docx', name: 'Word', icon: DocIcon, hue: 'blue' },
    { format: 'pdf', name: 'PDF', icon: PdfIcon, hue: 'red' },
    { format: 'markdown', name: 'Markdown', icon: MarkdownIcon, hue: 'purple' },
    { format: 'latex', name: 'LaTeX', icon: TexIcon, hue: 'green' },
];

export function fileExportFormatInfo(format: FileExportFormat) {
    return FILE_EXPORT_FORMATS.find(entry => entry.format === format) ?? FILE_EXPORT_FORMATS[0];
}

/** One menu item per export format, each asking where to save. */
export function fileExportFormatMenuItems(
    onSelect: (format: FileExportFormat) => void,
    disabled = false,
): MenuItem[] {
    return FILE_EXPORT_FORMATS.map(({ format, name, icon }) => ({
        label: `${name}…`,
        icon,
        onClick: () => onSelect(format),
        disabled,
    }));
}

/** An "Export" item whose submenu lists the export formats. */
export function fileExportMenuItem(
    onSelect: (format: FileExportFormat) => void,
    disabled = false,
): MenuItem {
    return {
        label: 'Export',
        onClick: () => {},
        disabled,
        submenu: fileExportFormatMenuItems(onSelect, disabled),
    };
}

export interface FileExportActions {
    /** Show the file in the system file manager. */
    reveal?: (path: string) => Promise<void>;
    /** Open the file in the system's default application. */
    open?: (path: string) => Promise<void>;
}

/** How long an export confirmation stays up (it carries actions to take). */
const FILE_EXPORT_MESSAGE_DURATION = 8000;

/**
 * Run a file export and tell the user how it went: a confirmation naming the
 * file and its folder (with any warnings, and "Show File" / "Open" buttons
 * when the host supports them), nothing when the save dialog was canceled,
 * an error otherwise.
 */
export async function exportWithFeedback(
    format: FileExportFormat,
    exportFile: () => Promise<FileExportResult>,
    notify: Notify,
    actions: FileExportActions = {},
): Promise<void> {
    let result: FileExportResult;
    try {
        result = await exportFile();
    } catch (error: any) {
        notify({
            type: 'error',
            title: 'Could not export',
            text: error?.message || 'The export failed.',
        });
        return;
    }
    if (result.status !== 'saved') return;

    // A file action fails when the file has since been moved or deleted.
    const withErrorFeedback = (action: ((path: string) => Promise<void>) | undefined, title: string) => (
        action
            ? async () => {
                try {
                    await action(result.path);
                } catch (error: any) {
                    notify({ type: 'error', title, text: error?.message || 'The file is no longer available.' });
                }
            }
            : undefined
    );

    notify({
        type: 'file_export',
        title: `Exported to ${fileExportFormatInfo(format).name}`,
        duration: FILE_EXPORT_MESSAGE_DURATION,
        fileExport: {
            format,
            fileName: result.fileName,
            folderName: result.folderName,
            companionFileNames: result.companionFileNames,
            warnings: result.warnings,
            onReveal: withErrorFeedback(actions.reveal, 'Could not show file'),
            onOpen: withErrorFeedback(actions.open, 'Could not open file'),
        },
    });
}
