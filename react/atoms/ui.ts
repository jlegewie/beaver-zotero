import { atom } from 'jotai';
import { currentSourcesAtom } from './input';
import { InputSource } from 'react/types/sources';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);

// UI behavior and elements
export const userScrolledAtom = atom(false);



// Sync status
export type SyncStatus = 'idle' | 'in_progress' | 'completed' | 'failed';
export const syncStatusAtom = atom<SyncStatus>('idle');
export const syncTotalAtom = atom<number>(0);
export const syncCurrentAtom = atom<number>(0);

// Source preview
export const previewedSourceIdAtom = atom<string | null>(null);
export const previewedSourceAtom = atom(
    (get) => {
        const previewSourceId = get(previewedSourceIdAtom);
        const currentSources = get(currentSourcesAtom);
        
        if (!previewSourceId) return null;
        
        // Find the attachment with the latest data from attachmentsAtom
        return currentSources.find(source => source.id === previewSourceId) || null;
    },
    (get, set, source: InputSource | null) => {
        // When setting a new attachment to preview, just store its ID
        set(previewedSourceIdAtom, source?.id || null);
    }
);