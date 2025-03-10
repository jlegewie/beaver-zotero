import React from 'react';
// @ts-ignore no idea why this is needed
import { useRef, useEffect, useState } from 'react';
import { Icon, CancelIcon } from './icons';
import { InputSource } from '../types/sources';
import { useSetAtom, useAtomValue, useAtom } from 'jotai';
import { previewedSourceAtom } from '../atoms/ui';
import { currentSourcesAtom, togglePinSourceAtom, removeSourceAtom } from '../atoms/input';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { openPDFInNewWindow } from '../utils/openPDFInNewWindow';
import PreviewZoteroItem from './previews/PreviewZoteroItem';
import PreviewZoteroSource from './previews/PreviewZoteroSource';
import { getZoteroItem } from '../utils/sourceUtils';
import { previewCloseTimeoutAtom } from './SourceButton';
import Button from './Button';
import IconButton from './IconButton';

interface SourcePreviewProps {
    source: InputSource;
}

const SourcePreview: React.FC<SourcePreviewProps> = ({ source }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const setPreviewedSource = useSetAtom(previewedSourceAtom);
    const togglePinSource = useSetAtom(togglePinSourceAtom);
    const removeSource = useSetAtom(removeSourceAtom);
    const [maxContentHeight, setMaxContentHeight] = useState<number | null>(null);
    const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);

    // Get source from sources atom
    const currentSources = useAtomValue(currentSourcesAtom);
    const currentSource = currentSources.find(att => att.id === source.id) || source;

    // Type of source
    const item = getZoteroItem(currentSource);
    if (!item) return null;
    const isRegularZoteroItem = item.isRegularItem();

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
            setPreviewedSource(null);
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
                setPreviewedSource(null);
            }
        };

        Zotero.getMainWindow().document.addEventListener('keydown', handleEscape);

        return () => {
            Zotero.getMainWindow().document.removeEventListener('keydown', handleEscape);
        };
    }, [setPreviewedSource]);

    const handlePin = () => {
        togglePinSource(currentSource.id);
        setPreviewedSource(null);
    };

    const handleRemove = () => {
        removeSource(currentSource);
        setPreviewedSource(null);
    };

    const handleOpen = async () => {
        if (item.isNote()) {
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
        } else {
            await openPDFInNewWindow(item);
        }
        setPreviewedSource(null);
    };

    // Determine if the PDF can be opened
    const canOpen =
        item.isPDFAttachment() ||
        (item.isRegularItem() && item.getAttachments().some(att => Zotero.Items.get(att).isPDFAttachment())) ||
        item.isNote();

    // Render appropriate content based on attachment type
    const renderContent = () => {
        if (!currentSource) return null;
        
        if (isRegularZoteroItem) {
            return <PreviewZoteroItem source={currentSource} item={item} />;
        } else if (item) {
            return <PreviewZoteroSource source={currentSource} item={item} />;
        } else {
            return null;
        }
    };

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
                    {renderContent()}
                </div>

                {/* buttons */}
                <div className="px-1 pt-1 flex flex-row items-center">
                    <div className="flex-1 gap-3 flex">
                        <Button
                            variant="ghost"
                            onClick={handlePin}
                        >
                            <ZoteroIcon 
                                icon={currentSource.pinned ? ZOTERO_ICONS.PIN_REMOVE : ZOTERO_ICONS.PIN} 
                                size={12}
                            />
                            <span>{currentSource.pinned ? 'Unpin' : 'Pin'}</span>
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={handleOpen}
                            disabled={!canOpen}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.OPEN} 
                                size={12}
                            />
                            Open
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
                    <div className="flex">
                        <IconButton
                            icon={CancelIcon}
                            variant="ghost"
                            onClick={() => setPreviewedSource(null)}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SourcePreview;