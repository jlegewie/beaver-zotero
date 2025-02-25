// @ts-nocheck no idea
import React, { useRef, useEffect, useState } from 'react';
import { Icon, CancelIcon } from './icons';
import { Attachment } from '../types/attachments';
import { useSetAtom, useAtomValue } from 'jotai';
import { previewedAttachmentAtom } from '../atoms/ui';
import { attachmentsAtom, togglePinAttachmentAtom, removeAttachmentAtom } from '../atoms/attachments';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { openPDFInNewWindow } from '../utils/openPDFInNewWindow';
import PreviewZoteroItem from './previews/PreviewZoteroItem';
import PreviewZoteroAttachment from './previews/PreviewZoteroAttachment';
import PreviewFileAttachment from './previews/PreviewFileAttachment';

interface AttachmentPreviewProps {
    attachment: Attachment;
}

const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({ attachment }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const setPreviewedAttachment = useSetAtom(previewedAttachmentAtom);
    const togglePinAttachment = useSetAtom(togglePinAttachmentAtom);
    const removeAttachment = useSetAtom(removeAttachmentAtom);
    const [maxContentHeight, setMaxContentHeight] = useState<number | null>(null);

    // Read the most up-to-date version of the attachment from the attachments atom
    const attachmentsAtomValue = useAtomValue(attachmentsAtom);
    const currentAttachment = attachmentsAtomValue.find(att => att.id === attachment.id) || attachment;

    // Type of attachment
    const isZoteroItem = currentAttachment.type === 'zotero_item' && currentAttachment.item;
    const isRegularZoteroItem = isZoteroItem && currentAttachment.item.isRegularItem();

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
                setPreviewedAttachment(null);
            }
        };

        const handleClickOutside = (e: MouseEvent) => {
            if (previewRef.current && !previewRef.current.contains(e.target as Node)) {
                setPreviewedAttachment(null);
            }
        };

        Zotero.getMainWindow().document.addEventListener('keydown', handleEscape);
        Zotero.getMainWindow().document.addEventListener('mousedown', handleClickOutside);

        return () => {
            Zotero.getMainWindow().document.removeEventListener('keydown', handleEscape);
            Zotero.getMainWindow().document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [setPreviewedAttachment]);

    const handlePin = () => {
        togglePinAttachment(currentAttachment.id);
        setPreviewedAttachment(null);
    };

    const handleRemove = () => {
        removeAttachment(currentAttachment);
        setPreviewedAttachment(null);
    };

    const handleOpen = async () => {
        if (currentAttachment.type === 'zotero_item') {
            await openPDFInNewWindow(currentAttachment.item);
        }
        setPreviewedAttachment(null);
    };

    // Determine if the PDF can be opened
    const canOpenPDF = isZoteroItem && (
        currentAttachment.item.isPDFAttachment() ||
        (currentAttachment.item.isRegularItem() && 
         currentAttachment.item.getAttachments().some(att => Zotero.Items.get(att).isPDFAttachment()))
    );

    // Render appropriate content based on attachment type
    const renderContent = () => {
        if (!currentAttachment) return null;
        
        if (currentAttachment.type === 'zotero_item') {
            if (isRegularZoteroItem) {
                return <PreviewZoteroItem attachment={currentAttachment} />;
            } else {
                return <PreviewZoteroAttachment attachment={currentAttachment} />;
            }
        } else {
            return <PreviewFileAttachment attachment={currentAttachment} />;
        }
    };

    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3">
            <div
                ref={previewRef}
                className="attachment-preview mx-0"
            >
                {/* Content Area */}
                <div 
                    className="attachment-content p-3"
                    style={{ maxHeight: maxContentHeight ? `${maxContentHeight}px` : '320px' }}
                >
                    {renderContent()}
                </div>

                {/* buttons */}
                <div className="p-1 flex flex-row items-center">
                    <div className="flex-1 gap-4">
                        <button
                            className="attachment-ghost-button"
                            onClick={handlePin}
                        >
                            <ZoteroIcon 
                                icon={currentAttachment.pinned ? ZOTERO_ICONS.PIN_REMOVE : ZOTERO_ICONS.PIN} 
                                size={12}
                            />
                            <span>{currentAttachment.pinned ? 'Unpin' : 'Pin'}</span>
                        </button>
                        <button
                            className="attachment-ghost-button"
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
                            className="attachment-ghost-button"
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
                            className="attachment-ghost-button"
                            onClick={() => setPreviewedAttachment(null)}
                        >
                            <Icon icon={CancelIcon} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AttachmentPreview;