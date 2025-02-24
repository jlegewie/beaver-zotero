// @ts-nocheck no idea
import React, { useRef, useEffect } from 'react';
import { Icon, PinIcon, CancelIcon } from './icons';
import { Attachment } from '../types/attachments';
import { useSetAtom } from 'jotai';
import { previewedAttachment } from '../atoms/ui';
import { togglePinAttachmentAtom, removeAttachmentAtom } from '../atoms/attachments';
import { AttachmentButton, getIconElement } from './AttachmentButton';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';

interface AttachmentPreviewProps {
    attachment: Attachment;
}

const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({ attachment }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const setPreviewedAttachment = useSetAtom(previewedAttachment);
    const togglePinAttachment = useSetAtom(togglePinAttachmentAtom);
    const removeAttachment = useSetAtom(removeAttachmentAtom);

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
        togglePinAttachment(attachment.id);
        setPreviewedAttachment(null);
    };

    const handleRemove = () => {
        removeAttachment(attachment);
        setPreviewedAttachment(null);
    };

    const handleOpen = () => {
        if (attachment.type === 'zotero_item') {
            // Open in Zotero
            attachment.item.select();
        }
        setPreviewedAttachment(null);
    };

    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3">
            <div
                ref={previewRef}
                className="attachment-preview mx-0"
                // style={{ backgroundColor: 'rgba(255, 0, 0, 0.2)' }}
            >
                {/* Content Area */}
                <div className="attachment-content p-3">
                    {attachment.type === 'zotero_item' && (
                        <>
                            <span className="flex items-center font-color-primary">
                                {getIconElement(attachment)}
                                {attachment.shortName}
                            </span>
                            <p className="text-base  m-1">{attachment.item.getDisplayTitle()}</p>
                            <div className="flex items-center font-color-secondary m-2">
                                <ZoteroIcon 
                                    icon={ZOTERO_ICONS.ATTACHMENTS} 
                                    size={16} 
                                    color="--accent-green" 
                                    className="mr-2"
                                />
                                3 Attachments
                            </div>
                            <div className="flex items-center font-color-secondary m-2">
                                <ZoteroIcon 
                                    icon={ZOTERO_ICONS.NOTES} 
                                    size={16} 
                                    color="--accent-yellow" 
                                    className="mr-2"
                                />
                                2 Notes
                            </div>
                        </>
                    )}
                    {attachment.type !== 'zotero_item' && (
                        <h3>{attachment.fullName}</h3>
                    )}
                </div>

                {/* buttons */}
                <div className="p-1 flex flex-row items-center">
                    <div className="flex-1 gap-3">
                        <button
                            className="attachment-ghost-button"
                            onClick={handlePin}
                        >
                            {/* <Icon icon={PinIcon} /> */}
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.PIN} 
                                size={12}
                            />
                            <span>{attachment.pinned ? 'Unpin' : 'Pin'}</span>
                        </button>
                        <button
                            className="attachment-ghost-button"
                            onClick={handleOpen}
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