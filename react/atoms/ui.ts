import { atom } from 'jotai';
import { PopupMessage, PopupMessageType } from '../types/popupMessage';
import { ExternalReference } from '../types/externalReferences';
import { getPref } from '../../src/utils/prefs';
import { isUsingBeaverCreditsAtom } from './models';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const selectedZoteroTabIdAtom = atom<string | null>(null);
export const isWebSearchEnabledAtom = atom(false);
export type PreferencePageTab = 'general' | 'sync' | 'permissions' | 'billing' | 'models' | 'actions' | 'advanced' | 'account';
export const activePreferencePageTabAtom = atom<PreferencePageTab>('general');
export const isPreferencePageVisibleAtom = atom(false);
export const mcpServerEnabledAtom = atom(getPref('mcpServerEnabled'));
export const mcpCreateNoteToolEnabledAtom = atom(getPref('mcpCreateNoteToolEnabled'));
export const dataProviderEnabledAtom = atom(getPref('dataProviderEnabled'));
export const requestPlusToolsAtom = atom(getPref('requestPlusTools'));
export const isWebSearchAllowedAtom = atom((get) => Boolean(get(isUsingBeaverCreditsAtom) || get(requestPlusToolsAtom)));
export const showFileStatusDetailsAtom = atom(false);
export const isThreadListViewAtom = atom(false);

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
// Shared scroll state for library and reader sidebars
export const userScrolledAtom = atom(false);
// Independent scroll state for separate window
export const windowUserScrolledAtom = atom(false);

// Popup Messages
export const popupMessagesAtom = atom<PopupMessage[]>([]);

export const hasPopupMessagesAtom = atom(get => get(popupMessagesAtom).length > 0);

// Remove popup messages by type
export const removePopupMessagesByTypeAtom = atom(
    null,
    (get, set, types: PopupMessageType[]) => {
        set(popupMessagesAtom, (prevMessages) =>
            prevMessages.filter((msg) => !types.includes(msg.type))
        );   
    }
);
