import React from 'react';
import { useRef, useEffect, useState } from 'react';
import { CancelIcon } from './icons';
import { useSetAtom, useAtom } from 'jotai';
import { previewTextSelectionAtom } from '../atoms/ui';
import { readerTextSelectionAtom } from '../atoms/input';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { previewCloseTimeoutAtom } from '../atoms/ui';
import Button from './button';
import IconButton from './IconButton';


const TextSelectionPreview: React.FC = () => {
    const previewRef = useRef<HTMLDivElement>(null);
    const setPreviewTextSelection = useSetAtom(previewTextSelectionAtom);
    const [maxContentHeight, setMaxContentHeight] = useState<number | null>(null);
    const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
    const [readerTextSelection, setReaderTextSelection] = useAtom(readerTextSelectionAtom);

    // Calculate available space for the preview
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
                    const maxHeight = Math.min(availableSpace - 30, 380);
                    const contentHeight = maxHeight - 46; // 46px for padding and button area
                    
                    setMaxContentHeight(Math.max(contentHeight, 100));
                }
            } catch (e) {
                console.error("Error calculating preview height:", e);
                setMaxContentHeight(320); // Fallback to a safe value
            }
        };

        calculateAvailableSpace();
        
        const win = Zotero.getMainWindow();
        win.addEventListener('resize', calculateAvailableSpace);
        
        return () => {
            win.removeEventListener('resize', calculateAvailableSpace);
        };
    }, []);

    // Cancel or start close timer
    const cancelCloseTimer = () => {
        if (previewCloseTimeout) {
            Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
            setPreviewCloseTimeout(null);
        }
    };

    const startCloseTimer = () => {
        // Clear any existing timeout
        cancelCloseTimer();
        
        // Start a new timeout
        const newTimeout = Zotero.getMainWindow().setTimeout(() => {
            setPreviewTextSelection(false);
            setPreviewCloseTimeout(null);
        }, 350); // 350ms delay before closing
        
        setPreviewCloseTimeout(newTimeout);
    };

    // Handle mouse enter/leave for preview
    const handleMouseEnter = () => {
        cancelCloseTimer();
    };

    const handleMouseLeave = () => {
        startCloseTimer();
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cancelCloseTimer();
        };
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setPreviewTextSelection(false);
            }
        };

        Zotero.getMainWindow().document.addEventListener('keydown', handleEscape);

        return () => {
            Zotero.getMainWindow().document.removeEventListener('keydown', handleEscape);
        };
    }, [setPreviewTextSelection]);

    const handleRemove = () => {
        setPreviewTextSelection(false)
        setReaderTextSelection(null);
    };

    const handleOpen = async () => {
        // Go to page
    };

    if (!readerTextSelection) return null;

    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3">
            <div
                ref={previewRef}
                className="source-preview mx-0"
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
            >
                {/* Content Area */}
                <div 
                    className="source-content p-3"
                    style={{ maxHeight: maxContentHeight ? `${maxContentHeight}px` : '320px' }}
                >
                    <div className="display-flex flex-row items-center">
                        <div className="font-color-primary">Text Selection</div>
                        <div className="flex-1"/>
                        <div className="font-color-secondary">Page {readerTextSelection.page}</div>
                    </div>
                    <p className="text-base my-2">{readerTextSelection.text}</p>
                </div>

                {/* buttons */}
                <div className="px-1 pt-1 display-flex flex-row items-center">
                    <div className="flex-1 gap-3 display-flex">
                        <Button
                            variant="ghost"
                            onClick={handleOpen}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.OPEN} 
                                size={12}
                            />
                            Go to Page
                        </Button>
                        <Button 
                            variant="ghost"
                            onClick={handleRemove}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.TRASH} 
                                size={12}
                            />
                            Remove
                        </Button>
                    </div>
                    <div className="display-flex">
                        <IconButton
                            icon={CancelIcon}
                            variant="ghost"
                            onClick={() => setPreviewTextSelection(false)}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TextSelectionPreview;