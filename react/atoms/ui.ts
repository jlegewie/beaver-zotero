import { atom } from 'jotai';
import { currentSourcesAtom } from './input';
import { Source } from 'react/types/sources';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);

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
    (get, set, source: Source | null) => {
        // When setting a new attachment to preview, just store its ID
        set(previewedSourceIdAtom, source?.id || null);
    }
);