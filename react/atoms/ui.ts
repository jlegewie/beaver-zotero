import { atom } from 'jotai';
import { TextSelection } from '../types/attachments/apiTypes';
import { PopupMessage, PopupMessageType } from '../types/popupMessage';
import { ExternalReference } from '../types/externalReferences';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const isWebSearchEnabledAtom = atom(false);
export const isPreferencePageVisibleAtom = atom(false);
export const showFileStatusDetailsAtom = atom(false);

// Error Report Dialog
export const isErrorReportDialogVisibleAtom = atom(false);
export const errorReportTextAtom = atom('');
export const isErrorReportSendingAtom = atom(false);

// Skipped Files Dialog
export const isSkippedFilesDialogVisibleAtom = atom(false);

// External Reference Details Dialog
export const isExternalReferenceDetailsDialogVisibleAtom = atom(false);
export const selectedExternalReferenceAtom = atom<ExternalReference | null>(null);

// Active dialog
export type DialogType = 'errorReport' | 'skippedFiles' | 'externalReferenceDetails' | null;

export const activeDialogAtom = atom<DialogType>((get) => {
    if (get(isErrorReportDialogVisibleAtom)) {
        return 'errorReport';
    }
    if (get(isSkippedFilesDialogVisibleAtom)) {
        return 'skippedFiles';
    }
    if (get(isExternalReferenceDetailsDialogVisibleAtom)) {
        return 'externalReferenceDetails';
    }
    return null;
});

// Zotero server download error
export const zoteroServerDownloadErrorAtom = atom(false);
export const zoteroServerCredentialsErrorAtom = atom(false);

// UI behavior and elements
export const userScrolledAtom = atom(false);

// Create a shared close timeout atom to coordinate between SourceButton and SourcePreview
export const previewCloseTimeoutAtom = atom<number | null>(null)

// Active preview
export type ActivePreview = 
    | { type: 'item'; content: Zotero.Item }
    | { type: 'textSelection'; content: TextSelection }
    | { type: 'annotation'; content: Zotero.Item }
    | { type: 'itemsSummary'; content: Zotero.Item[] }
    | null;

export const activePreviewAtom = atom<ActivePreview>(null);

// Popup Messages
export const popupMessagesAtom = atom<PopupMessage[]>([]);

// Remove popup messages by type
export const removePopupMessagesByTypeAtom = atom(
    null,
    (get, set, types: PopupMessageType[]) => {
        set(popupMessagesAtom, (prevMessages) =>
            prevMessages.filter((msg) => !types.includes(msg.type))
        );   
    }
);
