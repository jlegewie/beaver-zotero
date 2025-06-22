import { atom } from 'jotai';
import { InputSource } from '../types/sources';
import { TextSelection } from '../types/attachments/apiTypes';
import { PopupMessage } from '../types/popupMessage';
import { isFileUploaderRunningAtom, isFileUploaderFailedAtom } from './sync';


export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const isPreferencePageVisibleAtom = atom(false);

// UI behavior and elements
export const userScrolledAtom = atom(false);

// Create a shared close timeout atom to coordinate between SourceButton and SourcePreview
export const previewCloseTimeoutAtom = atom<number | null>(null)

// Database sync status
// TODO: Move to sync.ts
export type SyncStatus = 'idle' | 'in_progress' | 'completed' | 'failed';
// 'idle' - Initial state, no sync has been attempted
// 'in_progress' - Active sync operation
// 'completed' - Sync finished successfully
// 'failed' - Sync operation failed
export const syncStatusAtom = atom<SyncStatus>('idle');

// Derived atoms for combined status
export const syncingAtom = atom(
    (get) => {
        const dbStatus = get(syncStatusAtom);
        return dbStatus === 'in_progress' || get(isFileUploaderRunningAtom);
    }
);

export const syncErrorAtom = atom(
    (get) => {
        const dbStatus = get(syncStatusAtom);
        return dbStatus === 'failed' || get(isFileUploaderFailedAtom);
    }
);

// Active preview
export type ActivePreview = 
    | { type: 'source'; content: InputSource }
    | { type: 'textSelection'; content: TextSelection }
    | { type: 'annotation'; content: InputSource }
    | null;

export const activePreviewAtom = atom<ActivePreview>(null);

// Popup Messages
export const popupMessagesAtom = atom<PopupMessage[]>([]);