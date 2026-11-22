import { useCallback, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { FileExportFormat, FileExportResult } from '@beaver/agent-ui/host/types';
import { exportWithFeedback } from '../utils/fileExportFeedback';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { openExportedFile, revealExportedFile } from '../host/zotero/fileExport';

/**
 * One file export at a time, with the usual feedback: `run` exports in the
 * format given and reports the result (with Reveal and Open) or the error.
 * A run while another is in progress does nothing.
 */
export function useFileExport() {
    const [exporting, setExporting] = useState(false);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);
    const run = useCallback(async (format: FileExportFormat, exportFile: () => Promise<FileExportResult>) => {
        if (exporting) return;
        setExporting(true);
        try {
            await exportWithFeedback(format, exportFile, addPopupMessage, {
                reveal: revealExportedFile,
                open: openExportedFile,
            });
        } finally {
            setExporting(false);
        }
    }, [exporting, addPopupMessage]);
    return { exporting, run };
}
