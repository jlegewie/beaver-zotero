import { useLayoutEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { citationKeyToMarkerAtom, getOrAssignCitationMarkerAtom } from '../atoms/citations';

/**
 * Hook to get or assign a numeric citation marker for a given citation key.
 * 
 * Marker assignment is thread-scoped and consistent across all scenarios:
 * 
 * **During streaming:**
 * - Citations render as they appear in text
 * - Markers are assigned in render order (first citation = "1")
 * - When metadata arrives, updateCitationDataAtom uses the SAME markers
 * 
 * **When loading existing threads:**
 * - resetCitationMarkersAtom clears markers
 * - updateCitationDataAtom assigns markers based on citationMetadataAtom order
 * - Components then retrieve existing markers (no re-assignment)
 * - Order depends on backend: runs are processed chronologically,
 *   citations within runs use backend order (typically text-appearance order)
 * 
 * **Key guarantees:**
 * - Same citation key always gets the same marker within a thread
 * - Markers reset when thread changes (new thread, load thread, clear thread)
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

