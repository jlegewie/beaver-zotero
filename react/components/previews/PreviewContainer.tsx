import React, { useRef, useEffect, useState, useLayoutEffect, useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { activePreviewAtom, popupMessagesAtom, previewCloseTimeoutAtom } from '../../atoms/ui';
import TextSelectionPreviewContent from './TextSelectionPreviewContent';
import AnnotationPreviewContent from './AnnotationPreviewContent';
import ItemPreviewContent from './ItemPreviewContent';
import ItemsSummaryPreviewContent from './ItemsSummaryPreviewContent';
import { removePopupMessageAtom } from '../../utils/popupMessageUtils';
import { getWindowFromElement, getDocumentFromElement } from '../../utils/windowContext';

interface PreviewContainerProps {
    className?: string;
    hasAboveOverlay?: boolean;
}

// Preview height constants
const MIN_HEIGHT = 100;
const MAX_HEIGHT = 380;
const FALLBACK_HEIGHT = 250;

// Timer constants
const SHOW_DELAY = 100;
const HIDE_DELAY = 350;

// Preview container component
const PreviewContainer: React.FC<PreviewContainerProps> = ({ className, hasAboveOverlay = false }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const [activePreview, setActivePreview] = useAtom(activePreviewAtom);
    const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
    const [maxContentHeight, setMaxContentHeight] = useState<number | null>(null);
    const popupMessages = useAtomValue(popupMessagesAtom);
    const removePopupMessage = useSetAtom(removePopupMessageAtom);
    const [skipFade, setSkipFade] = useState(false);
    const skipFadePreviewKeyRef = useRef<string | null>(null);

    // Calculate available space
    useEffect(() => {
        // Get the correct window/document context for this component
        const doc = getDocumentFromElement(previewRef.current);
        const win = getWindowFromElement(previewRef.current);
        
        const calculateAvailableSpace = () => {
            try {
                const header = doc.getElementById('beaver-header');
                const prompt = doc.getElementById('beaver-prompt');
                
                if (header && prompt) {
                    const headerRect = header.getBoundingClientRect();
                    const promptRect = prompt.getBoundingClientRect();
                    
                    const availableSpace = promptRect.top - headerRect.bottom;
                    const maxHeight = Math.min(availableSpace - 30, MAX_HEIGHT); 
                    const contentHeight = maxHeight - 46; // Approx. height for padding and button area
                    
                    setMaxContentHeight(Math.max(contentHeight, MIN_HEIGHT)); // Ensure a minimum height
                } else {
                     setMaxContentHeight(FALLBACK_HEIGHT);
                }
            } catch (e) {
                console.error("Error calculating preview height:", e);
                setMaxContentHeight(FALLBACK_HEIGHT);
            }
        };

        calculateAvailableSpace();
        win.addEventListener('resize', calculateAvailableSpace);
        
        return () => {
            win.removeEventListener('resize', calculateAvailableSpace);
        };
    }, []);

    // Timer management
    const cancelCloseTimer = () => {
        if (previewCloseTimeout) {
            // Get the correct window context for this component
            const win = getWindowFromElement(previewRef.current);
            win.clearTimeout(previewCloseTimeout);
            setPreviewCloseTimeout(null);
        }
    };

    const startCloseTimer = () => {
        cancelCloseTimer(); // Clear existing timer before starting a new one
        // Get the correct window context for this component
        const win = getWindowFromElement(previewRef.current);
        const newTimeout = win.setTimeout(() => {
            setActivePreview(null);
            setPreviewCloseTimeout(null);
        }, HIDE_DELAY); // Delay before closing
        setPreviewCloseTimeout(newTimeout);
    };

    // Handle mouse events on the preview itself
    const handleMouseEnter = () => {
        cancelCloseTimer();
    };

    const handleMouseLeave = () => {
        startCloseTimer();
    };

    // Close on Escape key
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && activePreview) {
                setActivePreview(null);
                cancelCloseTimer();
            }
        };

        // Get the correct document context for this component
        const doc = getDocumentFromElement(previewRef.current);
        doc.addEventListener('keydown', handleEscape);

        return () => {
            doc.removeEventListener('keydown', handleEscape);
            cancelCloseTimer(); // Clean up timer on unmount
        };
    }, [activePreview, setActivePreview]); // Rerun if activePreview changes

    const previewItemKey = activePreview?.type === 'item' ? activePreview.content?.key : null;

    const hasMatchingPopup = useMemo(() => {
        if (!previewItemKey) {
            return false;
        }
        return popupMessages.some((message) => message.id === previewItemKey);
    }, [popupMessages, previewItemKey]);

    useLayoutEffect(() => {
        if (!previewItemKey) {
            skipFadePreviewKeyRef.current = null;
            setSkipFade(false);
            return;
        }

        if (skipFadePreviewKeyRef.current !== previewItemKey) {
            const shouldSkip = hasMatchingPopup;
            skipFadePreviewKeyRef.current = shouldSkip ? previewItemKey : null;
            setSkipFade(shouldSkip);
        }
    }, [previewItemKey, hasMatchingPopup]);

    useEffect(() => {
        if (previewItemKey && hasMatchingPopup) {
            removePopupMessage(previewItemKey);
        }
    }, [previewItemKey, hasMatchingPopup, removePopupMessage]);

    if (!activePreview || !maxContentHeight) {
        return null; // Render nothing if no active preview or height not calculated yet
    }

    const containerClassName = ['w-full', hasAboveOverlay ? 'mt-2' : '', className]
        .filter(Boolean)
        .join(' ');

    // Determine which content component to render
    const renderPreviewContent = () => {
        switch (activePreview.type) {
            case 'item':
                return <ItemPreviewContent item={activePreview.content} maxContentHeight={maxContentHeight} />;
            case 'textSelection':
                return <TextSelectionPreviewContent selection={activePreview.content} maxContentHeight={maxContentHeight} />;
            case 'annotation':
                return <AnnotationPreviewContent item={activePreview.content} maxContentHeight={maxContentHeight} />;
            case 'itemsSummary':
                return <ItemsSummaryPreviewContent items={activePreview.content} maxContentHeight={maxContentHeight} />;
            default:
                return null;
        }
    };

    return (
        <div className={containerClassName}>
            <div
                ref={previewRef}
                className={`source-preview border-popup shadow-md mx-0 ${skipFade ? 'no-fade' : ''}`}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                {renderPreviewContent()}
            </div>
        </div>
    );
};

export default PreviewContainer; 
