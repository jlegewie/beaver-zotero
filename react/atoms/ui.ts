import { atom } from 'jotai';
import { resourcesAtom } from './resources';
import { Resource } from 'react/types/resources';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);

// Resource preview
export const previewedResourceIdAtom = atom<string | null>(null);
export const previewedResourceAtom = atom(
    (get) => {
        const previewResourceId = get(previewedResourceIdAtom);
        const resources = get(resourcesAtom);
        
        if (!previewResourceId) return null;
        
        // Find the attachment with the latest data from attachmentsAtom
        return resources.find(resource => resource.id === previewResourceId) || null;
    },
    (get, set, resource: Resource | null) => {
        // When setting a new attachment to preview, just store its ID
        set(previewedResourceIdAtom, resource?.id || null);
    }
);