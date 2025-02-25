
import React from 'react';
// @ts-ignore no idea why this is needed
import { useRef, useEffect, useState } from 'react';
import { Icon, CancelIcon } from './icons';
import { Resource } from '../types/resources';
import { useSetAtom, useAtomValue } from 'jotai';
import { previewedResourceAtom } from '../atoms/ui';
import { resourcesAtom, togglePinResourceAtom, removeResourceAtom } from '../atoms/resources';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { openPDFInNewWindow } from '../utils/openPDFInNewWindow';
import PreviewZoteroItem from './previews/PreviewZoteroItem';
import PreviewZoteroAttachment from './previews/PreviewZoteroAttachment';
import PreviewFileAttachment from './previews/PreviewFileAttachment';
import { getZoteroItem } from '../utils/resourceUtils';

interface ResourcePreviewProps {
    resource: Resource;
}

const ResourcePreview: React.FC<ResourcePreviewProps> = ({ resource }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const setPreviewedResource = useSetAtom(previewedResourceAtom);
    const togglePinResource = useSetAtom(togglePinResourceAtom);
    const removeResource = useSetAtom(removeResourceAtom);
    const [maxContentHeight, setMaxContentHeight] = useState<number | null>(null);

    // Get resource from resources atom
    const resources = useAtomValue(resourcesAtom);
    const currentResource = resources.find(att => att.id === resource.id) || resource;

    // Type of resource
    const item = currentResource.type === 'zotero_item' ? getZoteroItem(currentResource) : null;
    const isZoteroItem = currentResource.type === 'zotero_item' && item;
    const isRegularZoteroItem = isZoteroItem && item.isRegularItem();

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

    // Keyboard shortcuts
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setPreviewedResource(null);
            }
        };

        const handleClickOutside = (e: MouseEvent) => {
            if (previewRef.current && !previewRef.current.contains(e.target as Node)) {
                setPreviewedResource(null);
            }
        };

        Zotero.getMainWindow().document.addEventListener('keydown', handleEscape);
        Zotero.getMainWindow().document.addEventListener('mousedown', handleClickOutside);

        return () => {
            Zotero.getMainWindow().document.removeEventListener('keydown', handleEscape);
            Zotero.getMainWindow().document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [setPreviewedResource]);

    const handlePin = () => {
        togglePinResource(currentResource.id);
        setPreviewedResource(null);
    };

    const handleRemove = () => {
        removeResource(currentResource);
        setPreviewedResource(null);
    };

    const handleOpen = async () => {
        if (currentResource.type === 'zotero_item' && item) {
            await openPDFInNewWindow(item);
        }
        setPreviewedResource(null);
    };

    // Determine if the PDF can be opened
    const canOpenPDF = isZoteroItem && (
        item.isPDFAttachment() ||
        (item.isRegularItem() && 
         item.getAttachments().some(att => Zotero.Items.get(att).isPDFAttachment()))
    );

    // Render appropriate content based on attachment type
    const renderContent = () => {
        if (!currentResource) return null;
        
        if (currentResource.type === 'zotero_item') {
            if (isRegularZoteroItem) {
                return <PreviewZoteroItem resource={currentResource} item={item} />;
            } else if (item) {
                return <PreviewZoteroAttachment resource={currentResource} item={item} />;
            } else {
                return null;
            }
        } else {
            return <PreviewFileAttachment resource={currentResource} />;
        }
    };

    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3">
            <div
                ref={previewRef}
                className="resource-preview mx-0"
            >
                {/* Content Area */}
                <div 
                    className="resource-content p-3"
                    style={{ maxHeight: maxContentHeight ? `${maxContentHeight}px` : '320px' }}
                >
                    {renderContent()}
                </div>

                {/* buttons */}
                <div className="p-1 flex flex-row items-center">
                    <div className="flex-1 gap-4">
                        <button
                            className="resource-ghost-button"
                            onClick={handlePin}
                        >
                            <ZoteroIcon 
                                icon={currentResource.pinned ? ZOTERO_ICONS.PIN_REMOVE : ZOTERO_ICONS.PIN} 
                                size={12}
                            />
                            <span>{currentResource.pinned ? 'Unpin' : 'Pin'}</span>
                        </button>
                        <button
                            className="resource-ghost-button"
                            onClick={handleOpen}
                            disabled={!canOpenPDF}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.OPEN} 
                                size={12}
                            />
                            Open
                        </button>
                        <button 
                            className="resource-ghost-button"
                            onClick={handleRemove}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.TRASH} 
                                size={12}
                            />
                            Remove
                        </button>
                    </div>
                    <div className="flex">
                        <button
                            className="resource-ghost-button"
                            onClick={() => setPreviewedResource(null)}
                        >
                            <Icon icon={CancelIcon} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ResourcePreview;