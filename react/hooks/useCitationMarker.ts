import { useLayoutEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { citationKeyToMarkerAtom, getOrAssignCitationMarkerAtom } from '../atoms/citations';

/**
 * Hook to get or assign a numeric citation marker for a given citation key.
 * 
 * This ensures consistent markers across streaming and post-metadata states:
 * - First render: Returns a stable prediction based on current map size
 * - After layout effect: Returns the actual assigned marker
 * - Same citation key always gets the same marker
 * 
 * @param citationKey Unique key for the citation (e.g., "zotero:1-ABC123" or "external:xyz")
 * @returns Numeric marker string (e.g., "1", "2", "3")
 */
export function useCitationMarker(citationKey: string): string {
    const markerMap = useAtomValue(citationKeyToMarkerAtom);
    const assignMarker = useSetAtom(getOrAssignCitationMarkerAtom);
    
    const existingMarker = markerMap[citationKey];
    
    // Use layout effect to assign marker synchronously after render (before paint)
    // This ensures no visual flicker - the assignment happens before the browser paints
    useLayoutEffect(() => {
        if (!existingMarker && citationKey && citationKey !== 'unknown') {
            assignMarker(citationKey);
        }
    }, [citationKey, existingMarker, assignMarker]);
    
    // Return existing marker, or compute what it will be after assignment
    // The prediction is accurate because we assign (size + 1) in the atom
    return existingMarker || (Object.keys(markerMap).length + 1).toString();
}

