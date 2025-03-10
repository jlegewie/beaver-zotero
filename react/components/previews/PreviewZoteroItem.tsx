import React from 'react';
// @ts-ignore no idea why this is needed
import { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { updateSourceChildItemKeysAtom } from '../../atoms/input';
import { isValidAttachment } from '../../utils/sourceUtils';
import { CSSItemTypeIcon } from '../icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { truncateText } from '../../utils/stringUtils';
import { InputSource } from '../../types/sources';
import PreviewHeading from './PreviewHeading';
import { threadSourceKeysAtom } from '../../atoms/threads';

interface PreviewZoteroItemProps {
    source: InputSource;
    item: Zotero.Item;
}

const PreviewZoteroItem: React.FC<PreviewZoteroItemProps> = ({ source, item }) => {
    const updateSourceChildItemKeys = useSetAtom(updateSourceChildItemKeysAtom);
    const [attachments, setAttachments] = useState<Zotero.Item[]>([]);
    const [notes, setNotes] = useState<Zotero.Item[]>([]);
    const [validItemIds, setValidItemIds] = useState<{[id: number]: boolean}>({});
    const threadSourceKeys = useAtomValue(threadSourceKeysAtom);

    // Fetch attachments and notes
    useEffect(() => {
        let isMounted = true;
        
        const fetchAttachmentsAndNotes = async () => {
            // Get attachments
            const attIds = item.getAttachments();
            const atts = attIds.map(id => Zotero.Items.get(id));
            if (isMounted) setAttachments(atts);

            // Check which attachments are valid
            const validityMap: {[id: number]: boolean} = {};
            for (const att of atts) {
                try {
                    const isValid = att.isNote() ? true : await isValidAttachment(att);
                    validityMap[att.id] = isValid;
                } catch (e) {
                    validityMap[att.id] = false;
                }
            }
            if (isMounted) setValidItemIds(validityMap);

            // Get notes
            const noteIds = item.getNotes();
            const noteItems = noteIds.map(id => Zotero.Items.get(id));
            if (isMounted) setNotes(noteItems);
        };

        fetchAttachmentsAndNotes();
        
        return () => {
            isMounted = false;
        };
    }, [source]);

    const handleToggleItem = (itemKey: string) => {
        const currentChildItemKeys = source.childItemKeys || [];
        const newChildItemKeys = currentChildItemKeys.includes(itemKey)
            ? currentChildItemKeys.filter(key => key !== itemKey)
            : [...currentChildItemKeys, itemKey];
        updateSourceChildItemKeys({
            sourceId: source.id,
            childItemKeys: newChildItemKeys
        });
    };

    const isItemSelected = (itemKey: string) => {
        if (source.childItemKeys) {
            return source.childItemKeys.includes(itemKey);
        }
        return false;
    };

    return (
        <>
            <PreviewHeading source={source} item={item}/>                
            <p className="text-base my-2 overflow-hidden text-ellipsis">{item.getDisplayTitle()}</p>
            
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
                    {attachments.map((att: Zotero.Item) => (
                        <div 
                            key={`att-${att.id}`}
                            className={validItemIds[att.id]
                                ? `flex p-2 items-center attachment-item cursor-pointer font-color-secondary ${threadSourceKeys.includes(att.key) ? 'opacity-60 cursor-not-allowed' : ''}`
                                : `flex p-2 items-center attachment-item cursor-not-allowed font-color-red`
                            }
                            onClick={() => validItemIds[att.id] && !threadSourceKeys.includes(att.key) ? handleToggleItem(att.key) : null}
                        >
                            <input 
                                type="checkbox" 
                                className="mr-2"
                                checked={isItemSelected(att.key)}
                                onChange={() => {}} // React requires this for controlled components
                                disabled={!validItemIds[att.id] || threadSourceKeys.includes(att.key)}
                            />
                            
                            <span className="mr-1 fit-content">
                                <CSSItemTypeIcon className="scale-85" itemType={att.getItemTypeIconName()} />
                            </span>
                            {truncateText(att.getDisplayTitle(), 32)}
                        </div>
                    ))}
                    
                    {/* Notes List */}
                    {notes.map((note: Zotero.Item) => (
                        <div 
                            key={`note-${note.id}`} 
                            className={`flex p-2 items-center attachment-item font-color-secondary ${threadSourceKeys.includes(note.key) ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                            onClick={() => !threadSourceKeys.includes(note.key) ? handleToggleItem(note.key) : null}
                        >
                            <input 
                                type="checkbox" 
                                className="mr-2" 
                                checked={isItemSelected(note.key)}
                                onChange={() => {}} // React requires this for controlled components
                                disabled={threadSourceKeys.includes(note.key)}
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