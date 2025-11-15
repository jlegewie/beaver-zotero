import { useEffect, useLayoutEffect, useRef } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { 
    libraryScrollPositionAtom, 
    readerScrollPositionAtom,
    isLibraryTabAtom,
    isSidebarVisibleAtom
} from '../atoms/ui';
import { currentThreadIdAtom } from '../atoms/threads';

/**
 * Hook to manage scroll position persistence across library and reader sidebars.
 * Saves scroll position when switching views and restores it when returning to the same thread.
 * 
 * @param containerRef - Ref to the scrollable container element
 * @param location - Current sidebar location ('library' or 'reader')
 */
export function useScrollPosition(
    containerRef: React.RefObject<HTMLElement>,
    location: 'library' | 'reader'
) {
    const threadId = useAtomValue(currentThreadIdAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    
    const [libraryScrollPosition, setLibraryScrollPosition] = useAtom(libraryScrollPositionAtom);
    const [readerScrollPosition, setReaderScrollPosition] = useAtom(readerScrollPositionAtom);
    
    const scrollPositionAtom = location === 'library' ? libraryScrollPosition : readerScrollPosition;
    const setScrollPosition = location === 'library' ? setLibraryScrollPosition : setReaderScrollPosition;
    
    // Track if we're currently visible
    const isCurrentLocationVisible = isSidebarVisible && (
        (location === 'library' && isLibraryTab) || 
        (location === 'reader' && !isLibraryTab)
    );
    
    // Track previous visibility state to detect transitions
    const previousVisibilityRef = useRef(isCurrentLocationVisible);
    const lastSavedScrollTopRef = useRef(0);
    
    // Save scroll position when becoming hidden
    useEffect(() => {
        const wasVisible = previousVisibilityRef.current;
        const isVisible = isCurrentLocationVisible;
        
        // When transitioning from visible to hidden, save scroll position
        if (wasVisible && !isVisible && containerRef.current && threadId) {
            const scrollTop = containerRef.current.scrollTop;
            lastSavedScrollTopRef.current = scrollTop;
            
            setScrollPosition({
                threadId,
                scrollTop
            });
        }
        
        previousVisibilityRef.current = isVisible;
    }, [isCurrentLocationVisible, threadId, containerRef, setScrollPosition]);
    
    // Restore scroll position when becoming visible (if same thread)
    // Use useLayoutEffect to restore BEFORE paint, preventing visual flicker
    useLayoutEffect(() => {
        if (!isCurrentLocationVisible || !containerRef.current || !threadId) {
            return;
        }
        
        // Only restore if we have a saved position for the current thread
        if (scrollPositionAtom.threadId === threadId && scrollPositionAtom.scrollTop > 0) {
            // Set scroll position synchronously before browser paint
            containerRef.current.scrollTop = scrollPositionAtom.scrollTop;
        }
    }, [isCurrentLocationVisible, threadId, scrollPositionAtom, containerRef]);
    
    // Save scroll position periodically while scrolling (for better persistence)
    useEffect(() => {
        if (!isCurrentLocationVisible || !containerRef.current || !threadId) {
            return;
        }
        
        const container = containerRef.current;
        let saveTimeout: number | null = null;
        
        const handleScroll = () => {
            // Debounce saves to avoid excessive updates
            if (saveTimeout !== null) {
                clearTimeout(saveTimeout);
            }
            
            saveTimeout = Zotero.getMainWindow().setTimeout(() => {
                if (container && threadId) {
                    const scrollTop = container.scrollTop;
                    
                    // Only save if position has changed significantly (avoid noise)
                    if (Math.abs(scrollTop - lastSavedScrollTopRef.current) > 10) {
                        lastSavedScrollTopRef.current = scrollTop;
                        setScrollPosition({
                            threadId,
                            scrollTop
                        });
                    }
                }
            }, 150); // Debounce delay
        };
        
        container.addEventListener('scroll', handleScroll);
        
        return () => {
            container.removeEventListener('scroll', handleScroll);
            if (saveTimeout !== null) {
                clearTimeout(saveTimeout);
            }
        };
    }, [isCurrentLocationVisible, threadId, containerRef, setScrollPosition]);
}

