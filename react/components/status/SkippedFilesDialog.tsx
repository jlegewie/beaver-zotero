import React, { useEffect } from 'react';
import { useAtom } from 'jotai';
import { isSkippedFilesDialogVisibleAtom } from '../../atoms/ui';
import { fileStatusSummaryAtom } from '../../atoms/files';
import { CancelIcon, InformationCircleIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import PaginatedFailedProcessingList from './PaginatedFailedProcessingList';
import { useAtomValue } from 'jotai';

/**
 * Skipped files dialog component
 */
const SkippedFilesDialog: React.FC = () => {
    const [isVisible, setIsVisible] = useAtom(isSkippedFilesDialogVisibleAtom);
    const fileStats = useAtomValue(fileStatusSummaryAtom);

    // Handle ESC key to close dialog
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isVisible) {
                handleClose();
            }
        };

        if (isVisible) {
            Zotero.getMainWindow().document.addEventListener('keydown', handleKeyDown);
            return () => Zotero.getMainWindow().document.removeEventListener('keydown', handleKeyDown);
        }
    }, [isVisible]);

    const handleClose = () => {
        setIsVisible(false);
    };

    if (!isVisible) return null;

    const skippedFilesCount = fileStats.planLimitProcessingCount + fileStats.unsupportedFileCount;

    return (
        <div className="absolute inset-0 z-50">
            {/* Overlay backdrop */}
            <div
                className="absolute inset-0 opacity-80 bg-quaternary"
                onClick={handleClose}
            />
            {/* Dialog container */}
            <div className="absolute inset-0 display-flex items-center justify-center pointer-events-none">
                <div
                    className="bg-sidepane border-popup rounded-lg shadow-lg mx-3 w-full overflow-hidden"
                    style={{
                        background: 'var(--material-mix-quarternary)',
                        border: '1px solid var(--fill-quinary)',
                        borderRadius: '8px',
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="display-flex flex-row items-center justify-between p-4 pb-3">
                        <div className="text-lg font-semibold">{skippedFilesCount > 0 ? `${skippedFilesCount} Skipped Files` : 'Skipped Files'}</div>
                        <IconButton
                            icon={CancelIcon}
                            onClick={handleClose}
                            className="scale-12"
                            ariaLabel="Close dialog"
                        />
                    </div>

                    {/* Content */}
                    <div className="px-4 pb-4 display-flex flex-col gap-4">
                        <PaginatedFailedProcessingList
                            statuses={['plan_limit', 'unsupported_file']}
                            count={skippedFilesCount}
                            title="Skipped files"
                            tooltipTitle="Reasons for skipping files"
                            icon={InformationCircleIcon}
                            collapseable={false}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SkippedFilesDialog;
