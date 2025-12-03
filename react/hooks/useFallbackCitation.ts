import { useState, useMemo, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { fallbackCitationCacheAtom } from '../atoms/citations';
import { getDisplayNameFromItem, getReferenceFromItem } from '../utils/sourceUtils';
import { createZoteroURI } from '../utils/zoteroURI';
import { logger } from '../../src/utils/logger';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';

export interface FallbackCitationData {
    formatted_citation: string;
    citation: string;
    url: string;
    loading: boolean;
}

interface UseFallbackCitationParams {
    cleanKey: string;
    libraryID: number;
    itemKey: string;
    /** If truthy, skip loading fallback data (citation metadata already available) */
    citationMetadataId?: string;
}

/**
 * Hook for loading fallback citation data when citation metadata is not available.
 * Uses a Jotai atom cache to persist data across component mounts.
 */
export function useFallbackCitation({
    cleanKey,
    libraryID,
    itemKey,
    citationMetadataId
}: UseFallbackCitationParams): FallbackCitationData | null {
    // Jotai atom cache for persistent storage across mounts
    const fallbackCache = useAtomValue(fallbackCitationCacheAtom);
    const setFallbackCache = useSetAtom(fallbackCitationCacheAtom);
    
    // Local state for tracking loading and current key
    const [fallbackDataState, setFallbackDataState] = useState<{
        key: string;
        data: FallbackCitationData | null;
    }>({ key: '', data: null });

    // Derived fallback citation that is valid only for the current key
    // Check atom cache first (sync) to avoid flicker on remount
    const fallbackCitation = useMemo(() => {
        if (fallbackDataState.key === cleanKey && fallbackDataState.data) {
            return fallbackDataState.data;
        }
        // Check Jotai atom cache for instant access on remount
        const cached = fallbackCache[cleanKey];
        if (cached) {
            return { ...cached, loading: false };
        }
        return null;
    }, [fallbackDataState, cleanKey, fallbackCache]);

    // Load fallback citation data when citation metadata is not available
    useEffect(() => {
        // Skip if we have citationMetadata or already have fallback (from atom cache or local state)
        if (citationMetadataId || fallbackCitation || !itemKey) return;
        
        let cancelled = false;
        
        const loadFallbackCitation = async () => {
            setFallbackDataState({ 
                key: cleanKey,
                data: { formatted_citation: '', citation: '', url: '', loading: true }
            });
            
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
                if (cancelled) return;
                
                if (!item) {
                    logger('useFallbackCitation: Failed to format citation for id: ' + cleanKey);
                    setFallbackDataState({ key: cleanKey, data: null });
                    return;
                }

                await loadFullItemDataWithAllTypes([item]);
                if (cancelled) return;

                const parentItem = item.parentItem;
                const itemToCite = item.isNote() ? item : parentItem || item;
                
                const citation = getDisplayNameFromItem(itemToCite);
                const formatted_citation = getReferenceFromItem(itemToCite);
                const url = createZoteroURI(item);

                // Cache the result in Jotai atom for future mounts
                setFallbackCache(prev => ({ ...prev, [cleanKey]: { formatted_citation, citation, url } }));

                setFallbackDataState({
                    key: cleanKey,
                    data: {
                        formatted_citation,
                        citation,
                        url,
                        loading: false
                    }
                });
            } catch (error) {
                if (cancelled) return;
                logger('useFallbackCitation: Error loading fallback citation: ' + error);
                setFallbackDataState({ key: cleanKey, data: null });
            }
        };

        loadFallbackCitation();

        // Cleanup to prevent setting state after unmount
        return () => { cancelled = true; };
    // Note: fallbackCitation intentionally excluded from deps
    // because we only want to load once when it's initially null
    }, [citationMetadataId, libraryID, itemKey, cleanKey, setFallbackCache]);

    return fallbackCitation;
}
