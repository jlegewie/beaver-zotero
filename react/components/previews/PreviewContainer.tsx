import React, { useRef, useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { activePreviewAtom, previewCloseTimeoutAtom } from '../../atoms/ui';
import SourcePreviewContent from './SourcePreviewContent';
import TextSelectionPreviewContent from './TextSelectionPreviewContent';
import AnnotationPreviewContent from './AnnotationPreviewContent';
import ItemPreviewContent from './ItemPreviewContent';

// Preview height constants
const MIN_HEIGHT = 100;
const MAX_HEIGHT = 380;
const FALLBACK_HEIGHT = 250;

// Timer constants
const SHOW_DELAY = 100;
const HIDE_DELAY = 350;

// Preview container component
const PreviewContainer: React.FC = () => {
    const previewRef = useRef<HTMLDivElement>(null);
    const [activePreview, setActivePreview] = useAtom(activePreviewAtom);
    const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
    const [maxContentHeight, setMaxContentHeight] = useState<number | null>(null);

    // Calculate available space
    useEffect(() => {
        const calculateAvailableSpace = () => {
            try {
                const doc = Zotero.getMainWindow().document;
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
        const win = Zotero.getMainWindow();
        win.addEventListener('resize', calculateAvailableSpace);
        
        return () => {
            win.removeEventListener('resize', calculateAvailableSpace);
        };
    }, []);

    // Timer management
    const cancelCloseTimer = () => {
        if (previewCloseTimeout) {
            Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
            setPreviewCloseTimeout(null);
        }
    };

    const startCloseTimer = () => {
        cancelCloseTimer(); // Clear existing timer before starting a new one
        const newTimeout = Zotero.getMainWindow().setTimeout(() => {
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

        const doc = Zotero.getMainWindow().document;
        doc.addEventListener('keydown', handleEscape);

        return () => {
            doc.removeEventListener('keydown', handleEscape);
            cancelCloseTimer(); // Clean up timer on unmount
        };
    }, [activePreview, setActivePreview]); // Rerun if activePreview changes

    if (!activePreview || !maxContentHeight) {
        return null; // Render nothing if no active preview or height not calculated yet
    }

    // Determine which content component to render
    const renderPreviewContent = () => {
        switch (activePreview.type) {
            case 'source':
                return <SourcePreviewContent source={activePreview.content} maxContentHeight={maxContentHeight} />;
            case 'item':
                return <ItemPreviewContent item={activePreview.content} maxContentHeight={maxContentHeight} />;
            case 'textSelection':
                return <TextSelectionPreviewContent selection={activePreview.content} maxContentHeight={maxContentHeight} />;
            case 'annotation':
                return <AnnotationPreviewContent attachment={activePreview.content} maxContentHeight={maxContentHeight} />;
            default:
                return null;
        }
    };

    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3">
            <div
                ref={previewRef}
                className="source-preview border-popup shadow-md mx-0"
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                {renderPreviewContent()}
            </div>
        </div>
    );
};

export default PreviewContainer; 