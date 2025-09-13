import { atom } from 'jotai';
import { InputSource } from '../types/sources';
import { TextSelection } from '../types/attachments/apiTypes';
import { PopupMessage } from '../types/popupMessage';
import { isFileUploaderRunningAtom, isFileUploaderFailedAtom } from './sync';


export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const isPreferencePageVisibleAtom = atom(false);
export const showFileStatusDetailsAtom = atom(false);

// Error Report Dialog
export const isErrorReportDialogVisibleAtom = atom(false);
export const errorReportTextAtom = atom('');
export const isErrorReportSendingAtom = atom(false);

// Skipped Files Dialog
export const isSkippedFilesDialogVisibleAtom = atom(false);

// Library Selection Dialog
export const isLibrarySelectionDialogVisibleAtom = atom(false);

// Active dialog
export type DialogType = 'errorReport' | 'skippedFiles' | 'librarySelection' | null;

export const activeDialogAtom = atom<DialogType>((get) => {
    if (get(isErrorReportDialogVisibleAtom)) {
        return 'errorReport';
    }
    if (get(isSkippedFilesDialogVisibleAtom)) {
        return 'skippedFiles';
    }
    if (get(isLibrarySelectionDialogVisibleAtom)) {
        return 'librarySelection';
    }
    return null;
});

// UI behavior and elements
export const userScrolledAtom = atom(false);

// Create a shared close timeout atom to coordinate between SourceButton and SourcePreview
export const previewCloseTimeoutAtom = atom<number | null>(null)

// Active preview
export type ActivePreview = 
    | { type: 'source'; content: InputSource }
    | { type: 'textSelection'; content: TextSelection }
    | { type: 'annotation'; content: InputSource }
    | null;

export const activePreviewAtom = atom<ActivePreview>(null);

// Popup Messages
export const popupMessagesAtom = atom<PopupMessage[]>([]);