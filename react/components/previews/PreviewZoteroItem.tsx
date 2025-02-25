// @ts-nocheck no idea
import React, { useEffect, useState } from 'react';
import { ZoteroAttachment } from '../../types/attachments';
import { useSetAtom } from 'jotai';
import { updateChildItemIdsAtom, isValidZoteroItem } from '../../atoms/attachments';
import { CSSItemTypeIcon } from '../icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { truncateText } from '../../utils/truncateText';

interface PreviewZoteroItemProps {
    attachment: ZoteroAttachment;
}

const PreviewZoteroItem: React.FC<PreviewZoteroItemProps> = ({ attachment }) => {
    const updateChildItemIds = useSetAtom(updateChildItemIdsAtom);
    const [attachments, setAttachments] = useState<any[]>([]);
    const [notes, setNotes] = useState<any[]>([]);
    const [validAttachments, setValidAttachments] = useState<{[id: number]: boolean}>({});

    // Fetch attachments and notes
    useEffect(() => {
        let isMounted = true;
        
        const fetchAttachmentsAndNotes = async () => {
            // Get attachments
            const attIds = attachment.item.getAttachments();
            const atts = attIds.map(id => Zotero.Items.get(id));
            if (isMounted) setAttachments(atts);

            // Check which attachments are valid
            const validityMap: {[id: number]: boolean} = {};
            for (const att of atts) {
                try {
                    const isValid = await isValidZoteroItem(att);
                    validityMap[att.id] = isValid;
                } catch (e) {
                    validityMap[att.id] = false;
                }
            }
            if (isMounted) setValidAttachments(validityMap);

            // Get notes
            const noteIds = attachment.item.getNotes();
            const noteItems = noteIds.map(id => Zotero.Items.get(id));
            if (isMounted) setNotes(noteItems);

            // Set best attachment as default if childItemIds is not set
            if (!attachment.childItemIds && isMounted) {
                try {
                    const bestAtt = await attachment.item.getBestAttachment();
                    if (bestAtt && isMounted) {
                        updateChildItemIds({
                            attachmentId: attachment.id,
                            childItemIds: [bestAtt.id.toString()]
                        });
                    }
                } catch (e) {
                    console.error("Error getting best attachment:", e);
                }
            }
        };

        fetchAttachmentsAndNotes();
        
        return () => {
            isMounted = false;
        };
    }, [attachment]);

    const handleToggleItem = (itemId: string) => {
        const currentChildItemIds = attachment.childItemIds || [];
        const newChildItemIds = currentChildItemIds.includes(itemId)
            ? currentChildItemIds.filter(id => id !== itemId)
            : [...currentChildItemIds, itemId];
        
        console.log("newChildItemIds", newChildItemIds);
        updateChildItemIds({
            attachmentId: attachment.id,
            childItemIds: newChildItemIds
        });
    };

    const isItemSelected = (itemId: string) => {
        if (attachment.childItemIds) {
            return attachment.childItemIds.includes(itemId);
        }
        return false;
    };

    return (
        <>
            <span className="flex items-center font-color-primary">
                {<CSSItemTypeIcon itemType={attachment.item.getItemTypeIconName()} />}
                <span className="ml-2">{attachment.shortName}</span>
            </span>
            <p className="text-base my-2">{attachment.item.getDisplayTitle()}</p>
            
            {/* Combined Attachments and Notes Section */}
            <div className="mt-3">
                <div className="flex items-center font-color-secondary mb-2">
                    <ZoteroIcon 
                        icon={ZOTERO_ICONS.ATTACHMENTS} 
                        size={15} 
                        color="--accent-green"
                        className="mr-2"
                    />
                    <span>{attachments.length} Attachment{attachments.length !== 1 ? 's' : ''}</span>
                    
                    <span className="mx-1"></span>
                    
                    <ZoteroIcon 
                        icon={ZOTERO_ICONS.NOTES}
                        size={15}
                        color="--accent-yellow"
                        className="mr-2"
                    />
                    <span>{notes.length} Note{notes.length !== 1 ? 's' : ''}</span>
                </div>
                
                <div className="ml-6 space-y-1">
                    {/* Attachments List */}
                    {attachments.map(att => (
                        <div 
                            key={`att-${att.id}`}
                            className={validAttachments[att.id]
                                ? `flex p-2 items-center attachment-item cursor-pointer font-color-secondary`
                                : `flex p-2 items-center attachment-item cursor-not-allowed font-color-red`
                            }
                            onClick={() => validAttachments[att.id] ? handleToggleItem(att.id.toString()) : null}
                        >
                            <input 
                                type="checkbox" 
                                className="mr-2" 
                                checked={isItemSelected(att.id.toString())}
                                onChange={() => {}} // React requires this for controlled components
                                disabled={!validAttachments[att.id]}
                            />
                            
                            <span className="mr-1 scale-90"><CSSItemTypeIcon itemType={att.getItemTypeIconName()} /></span>
                            {truncateText(att.getDisplayTitle(), 32)}
                        </div>
                    ))}
                    
                    {/* Notes List */}
                    {notes.map(note => (
                        <div 
                            key={`note-${note.id}`} 
                            className="flex p-2 items-center attachment-item font-color-secondary cursor-pointer"
                            onClick={() => handleToggleItem(note.id.toString())}
                        >
                            <input 
                                type="checkbox" 
                                className="mr-2" 
                                checked={isItemSelected(note.id.toString())}
                                onChange={() => {}} // React requires this for controlled components
                            />
                            <span className="mr-1 scale-90"><CSSItemTypeIcon itemType={note.getItemTypeIconName()} /></span>
                            {truncateText(note.getNoteTitle(), 32)}
                        </div>
                    ))}
                    
                    {/* Show message if no attachments or notes */}
                    {attachments.length === 0 && notes.length === 0 && (
                        <div className="text-gray-400 italic">No attachments or notes</div>
                    )}
                </div>
            </div>
        </>
    );
};

export default PreviewZoteroItem; 