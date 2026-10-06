import type { FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { DocIcon, MarkdownIcon, PdfIcon, TexIcon } from '@beaver/agent-ui/icons';
import { logger } from '@beaver/agent-core/platform/logger';
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

/**
 * File-system failures, by what the platform error names, as sentences a user
 * can act on. Anything else keeps its own message unless it is a raw
 * platform code.
 */
const FILE_ERROR_MESSAGES: Array<[RegExp, string]> = [
    [/ACCESS_DENIED|READ_ONLY|NotAllowedError|permission denied/i, 'Beaver cannot save to that location. Choose a folder you can write to and try again.'],
    [/IS_LOCKED|NoModificationAllowedError|in use/i, 'The file is open in another application. Close it there and try again.'],
    [/NO_DEVICE_SPACE|disk full|QuotaExceededError/i, 'There is not enough disk space to save the file.'],
    [/FILE_NOT_FOUND|TARGET_DOES_NOT_EXIST|NotFoundError|UNRECOGNIZED_PATH/i, 'That folder no longer exists. Choose another location and try again.'],
    [/NAME_TOO_LONG/i, 'The file name is too long. Choose a shorter name and try again.'],
];

/** A user-facing sentence for an export failure. */
export function exportErrorMessage(error: unknown): string {
    const raw = `${(error as any)?.name ?? ''} ${(error as any)?.message ?? error ?? ''}`;
    for (const [pattern, message] of FILE_ERROR_MESSAGES) {
        if (pattern.test(raw)) return message;
    }
    const message = (error as any)?.message;
    if (typeof message === 'string' && message.trim() && !/NS_ERROR_/.test(message)) return message;
    return 'The file could not be saved.';
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
        logger(`File export (${format}) failed: ${error?.name ?? ''} ${error?.message ?? error}`, 1);
        notify({
            type: 'error',
            title: 'Could not export',
            text: exportErrorMessage(error),
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
