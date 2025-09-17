import React, { useEffect } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import {
    activeDialogAtom,
    isErrorReportDialogVisibleAtom,
    isSkippedFilesDialogVisibleAtom,
    errorReportTextAtom,
    isErrorReportSendingAtom,
    DialogType,
} from '../../atoms/ui';
import ErrorReportDialog from './ErrorReportDialog';
import SkippedFilesDialog from './SkippedFilesDialog';

const dialogs: Record<Exclude<DialogType, null>, React.ComponentType<any>> = {
    errorReport: ErrorReportDialog,
    skippedFiles: SkippedFilesDialog,
};

const DialogContainer: React.FC = () => {
    const activeDialog = useAtomValue(activeDialogAtom);
    const isSendingError = useAtomValue(isErrorReportSendingAtom);
    const setIsErrorReportDialogVisible = useSetAtom(isErrorReportDialogVisibleAtom);
    const setErrorReportText = useSetAtom(errorReportTextAtom);
    const setIsSkippedFilesDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);

    const handleClose = () => {
        if (activeDialog === 'errorReport') {
            if (isSendingError) return;
            setIsErrorReportDialogVisible(false);
            setErrorReportText('');
        } else if (activeDialog === 'skippedFiles') {
            setIsSkippedFilesDialogVisible(false);
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && activeDialog) {
                handleClose();
            }
        };

        if (activeDialog) {
            Zotero.getMainWindow().document.addEventListener('keydown', handleKeyDown);
            return () => Zotero.getMainWindow().document.removeEventListener('keydown', handleKeyDown);
        }
    }, [activeDialog, isSendingError]);

    if (!activeDialog) return null;

    const DialogContent = dialogs[activeDialog];

    return (
        <div
            className="absolute inset-0 z-50 pointer-events-auto"
            onClick={handleClose}
        >
            {/* Overlay backdrop */}
            <div
                className="absolute inset-0 opacity-80 bg-quaternary"
            />
            {/* Dialog container */}
            <div className="absolute inset-0 display-flex items-center justify-center shadow-lg">
                <DialogContent />
            </div>
        </div>
    );
};

export default DialogContainer;
