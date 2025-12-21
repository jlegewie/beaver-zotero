import React, { useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import {
    activeDialogAtom,
    isErrorReportDialogVisibleAtom,
    isSkippedFilesDialogVisibleAtom,
    errorReportTextAtom,
    isErrorReportSendingAtom,
    isExternalReferenceDetailsDialogVisibleAtom,
    selectedExternalReferenceAtom,
    DialogType,
} from '../../atoms/ui';
import ErrorReportDialog from './ErrorReportDialog';
import SkippedFilesDialog from './SkippedFilesDialog';
import ExternalReferenceDetailsDialog from './ExternalReferenceDetailsDialog';
import { getDocumentFromElement } from '../../utils/windowContext';

const dialogs: Record<Exclude<DialogType, null>, React.ComponentType<any>> = {
    errorReport: ErrorReportDialog,
    skippedFiles: SkippedFilesDialog,
    externalReferenceDetails: ExternalReferenceDetailsDialog,
};

const DialogContainer: React.FC = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const activeDialog = useAtomValue(activeDialogAtom);
    const isSendingError = useAtomValue(isErrorReportSendingAtom);
    const setIsErrorReportDialogVisible = useSetAtom(isErrorReportDialogVisibleAtom);
    const setErrorReportText = useSetAtom(errorReportTextAtom);
    const setIsSkippedFilesDialogVisible = useSetAtom(isSkippedFilesDialogVisibleAtom);
    const setIsExternalReferenceDetailsVisible = useSetAtom(isExternalReferenceDetailsDialogVisibleAtom);
    const setSelectedExternalReference = useSetAtom(selectedExternalReferenceAtom);

    const handleClose = () => {
        if (activeDialog === 'errorReport') {
            if (isSendingError) return;
            setIsErrorReportDialogVisible(false);
            setErrorReportText('');
        } else if (activeDialog === 'skippedFiles') {
            setIsSkippedFilesDialogVisible(false);
        } else if (activeDialog === 'externalReferenceDetails') {
            setIsExternalReferenceDetailsVisible(false);
            setSelectedExternalReference(null);
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && activeDialog) {
                handleClose();
            }
        };

        if (activeDialog) {
            // Get the correct document context for this component
            const doc = getDocumentFromElement(containerRef.current);
            doc.addEventListener('keydown', handleKeyDown);
            return () => doc.removeEventListener('keydown', handleKeyDown);
        }
    }, [activeDialog, isSendingError]);

    if (!activeDialog) return null;

    const DialogContent = dialogs[activeDialog];

    return (
        <div
            ref={containerRef}
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
