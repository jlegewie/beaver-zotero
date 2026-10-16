import React from 'react';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { AlertIcon, ArrowUpRightIcon, CancelIcon, Icon } from '../../icons/icons';
import type { PopupMessage } from '../../../types/popupMessage';
import { fileExportFormatInfo } from '../../../utils/fileExportFeedback';

interface FileExportMessageContentProps {
    message: PopupMessage;
    onDismiss: () => void;
}

/**
 * Confirmation of a finished file export: the format's icon on a tile in the
 * format's colour beside what happened, the file, the folder it went to and
 * any warnings, then buttons to show the file or open it.
 */
const FileExportMessageContent: React.FC<FileExportMessageContentProps> = ({ message, onDismiss }) => {
    const data = message.fileExport;
    if (!data) return null;
    const { icon, hue, name } = fileExportFormatInfo(data.format);

    const location = [
        data.folderName ? `in ${data.folderName}` : '',
        data.companionFileNames.length > 0 ? `with ${data.companionFileNames.join(', ')}` : '',
    ].filter(Boolean).join(' · ');

    const runAndDismiss = (action: () => Promise<void>) => () => {
        onDismiss();
        void action();
    };

    return (
        <div className="display-flex flex-col gap-3 w-full min-w-0">
            {/* Icon, text and dismiss share a top edge, so the tile anchors the
                title however many lines (folder, warnings) follow it. */}
            <div className="display-flex flex-row items-start gap-3 w-full min-w-0">
                <div
                    className="display-flex items-center justify-center rounded-lg flex-shrink-0"
                    style={{
                        width: '2.25rem',
                        height: '2.25rem',
                        background: `var(--tag-${hue}-quarternary)`,
                        color: `var(--tag-${hue}-primary)`,
                    }}
                    aria-label={`${name} file`}
                    role="img"
                >
                    <Icon icon={icon} size={22} />
                </div>
                {/* Three steps of emphasis: what happened, the file, where it is. */}
                <div className="display-flex flex-col gap-05 flex-1 min-w-0">
                    <div className="text-base font-medium font-color-primary truncate">
                        {message.title}
                    </div>
                    <div className="text-sm font-color-primary truncate" title={data.fileName}>
                        {data.fileName}
                    </div>
                    {location && (
                        <div className="text-sm font-color-secondary truncate" title={location}>
                            {location}
                        </div>
                    )}
                    {data.warnings.length > 0 && (
                        <div className="display-flex flex-col gap-1 w-full mt-1">
                            {data.warnings.map((warning, index) => (
                                <div key={index} className="display-flex flex-row items-start gap-15 text-sm font-color-secondary">
                                    <Icon icon={AlertIcon} className="font-color-orange flex-shrink-0 mt-020" />
                                    <span>{warning}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={onDismiss}
                    ariaLabel="Dismiss"
                    className="flex-shrink-0"
                />
            </div>

            {(data.onReveal || data.onOpen) && (
                <div className="display-flex flex-row gap-2 justify-end w-full">
                    {data.onReveal && (
                        <Button variant="outline" onClick={runAndDismiss(data.onReveal)}>
                            Show File
                        </Button>
                    )}
                    {data.onOpen && (
                        <Button variant="solid" rightIcon={ArrowUpRightIcon} onClick={runAndDismiss(data.onOpen)}>
                            Open
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
};

export default FileExportMessageContent;
