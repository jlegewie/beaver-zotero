import React, { useState, useRef } from 'react';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { CSSItemTypeIcon, CSSIcon } from './icons/zotero';
import { FILE_SIZE_LIMIT, VALID_MIME_TYPES } from '../utils/sourceUtils';
import { isValidAnnotationType } from '../types/attachments/apiTypes';
import { updateSourcesFromZoteroItemsAtom } from '../atoms/input';
import { store } from '../index';
import { getPref } from '../../src/utils/prefs';
import { useSetAtom } from 'jotai';

interface DragDropWrapperProps {
    children: React.ReactNode;
}

const updateSourcesFromZoteroSelection = getPref("updateSourcesFromZoteroSelection");

const DragDropWrapper: React.FC<DragDropWrapperProps> = ({ 
    children
}) => {
    // Drag and drop states
    const [objectIcon, setObjectIcon] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragError, setDragError] = useState<string | null>(null);
    const [dragCount, setDragCount] = useState<number>(0);
    const [dragType, setDragType] = useState<'item' | 'annotation' | null>(null);
    const dragErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const updateSourcesFromZoteroItems = useSetAtom(updateSourcesFromZoteroItemsAtom);

    // Show error message temporarily
    const showErrorMessage = (message: string) => {
        setDragError(message);
        
        // Clear any existing timeout
        if (dragErrorTimeoutRef.current) {
            clearTimeout(dragErrorTimeoutRef.current);
        }
        
        // Clear error message after 1 second
        dragErrorTimeoutRef.current = setTimeout(() => {
            setDragError(null);
            dragErrorTimeoutRef.current = null;
        }, 1000);
    };

    const getObjectIcon = (annotationType: string) => {
        switch (annotationType) {
            case 'highlight':
                return ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
            case 'underline':
                return ZOTERO_ICONS.ANNOTATE_UNDERLINE;
            case 'note':
                return ZOTERO_ICONS.ANNOTATE_NOTE;
            case 'text':
                return ZOTERO_ICONS.ANNOTATE_TEXT;
            case 'image':
                return ZOTERO_ICONS.ANNOTATE_AREA;
            default:
                return ZOTERO_ICONS.ANNOTATION;
        }
    }

    // Handle drag events
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Set appropriate drop effect
        if (e.dataTransfer.types.includes('zotero/annotation') || 
            e.dataTransfer.types.includes('zotero/item')) {
            e.dataTransfer.dropEffect = 'copy';
        }
            
        // Handle Zotero annotations
        if (e.dataTransfer.types.includes('zotero/annotation')) {
            try {
                const annotationData = JSON.parse(e.dataTransfer.getData('zotero/annotation'));
                if (annotationData && annotationData.length > 0) {
                    const annotationType = annotationData[0].type;
                    if(isValidAnnotationType(annotationType)) {
                        setObjectIcon(getObjectIcon(annotationType));
                        setIsDragging(true);
                        setDragType('annotation');
                        setDragCount(annotationData.length);
                    }
                    else {
                        setObjectIcon(ZOTERO_ICONS.ANNOTATION);
                        setDragError("Annotation type not supported");
                    }
                }
            } catch (error) {
                console.error("Error parsing annotation data:", error);
            }
        }
        
        // Handle Zotero items
        else if (e.dataTransfer.types.includes('zotero/item')) {
            try {
                const itemIDs = e.dataTransfer.getData('zotero/item');
                if (itemIDs) {
                    const ids = itemIDs.split(',').map(id => parseInt(id));
                    setDragCount(ids.length);
                    
                    // Set icon based on first item
                    if (ids.length > 0) {
                        const item = Zotero.Items.get(ids[0]);
                        if (item) {
                            const iconName = item.getItemTypeIconName();
                            setObjectIcon(iconName || ZOTERO_ICONS.ATTACHMENTS);
                            setIsDragging(true);
                            setDragType('item');
                        }
                    }
                }
            } catch (error) {
                console.error("Error handling item data:", error);
            }
        }
    };

    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Handle Zotero annotations
        if (e.dataTransfer.types.includes('zotero/annotation')) {
            try {
                const annotationData = JSON.parse(e.dataTransfer.getData('zotero/annotation'));
                if (annotationData && annotationData.length > 0) {
                    const annotationType = annotationData[0].type;
                    if(isValidAnnotationType(annotationType)) {
                        setObjectIcon(getObjectIcon(annotationType));
                        setIsDragging(true);
                        setDragType('annotation');
                        setDragCount(annotationData.length);
                    }
                    else {
                        setObjectIcon(ZOTERO_ICONS.ANNOTATION);
                        setDragError("Annotation type not supported");
                    }
                }
            } catch (error) {
                console.error("Error parsing annotation data:", error);
            }
        }
        
        // Handle Zotero items
        else if (e.dataTransfer.types.includes('zotero/item')) {
            try {
                const itemIDs = e.dataTransfer.getData('zotero/item');
                if (itemIDs) {
                    const ids = itemIDs.split(',').map(id => parseInt(id));
                    setDragCount(ids.length);
                    
                    // Set icon based on first item
                    if (ids.length > 0) {
                        const item = Zotero.Items.get(ids[0]);
                        if (item) {
                            const iconName = item.getItemTypeIconName();
                            setObjectIcon(iconName || ZOTERO_ICONS.ATTACHMENTS);
                            setIsDragging(true);
                            setDragType('item');
                        }
                    }
                }
            } catch (error) {
                console.error("Error handling item data:", error);
            }
        }
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Check if the drag is leaving the entire container
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragging(false);
            setObjectIcon(null);
            setDragError(null);
            setDragType(null);
            setDragCount(0);
        }
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        setObjectIcon(null);
        setDragError(null);
        setDragType(null);
        setDragCount(0);

        // Handle Zotero items
        if (!updateSourcesFromZoteroSelection && e.dataTransfer.types.includes('zotero/item')) {
            const itemIDs = e.dataTransfer.getData('zotero/item');
            if (itemIDs) {
                // Convert comma-separated IDs to an array of integers
                const ids = itemIDs.split(',').map(id => parseInt(id));
                const items = await Zotero.Items.getAsync(ids);
                
                // Update sources from Zotero items
                await updateSourcesFromZoteroItems(items, true);
            }
            return;
        }

        // Handle Zotero annotations
        if (e.dataTransfer.types.includes("zotero/annotation")) {
            const annotationData = JSON.parse(e.dataTransfer.getData('zotero/annotation'));
            console.log('annotationData', annotationData[0])
            for (const data of annotationData) {
                const attachment = Zotero.Items.get(data.attachmentItemID);
                const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.libraryID, data.id);
                // Skip if item is not an annotation or has an invalid annotation type
                if(!item || !item.isAnnotation() || !isValidAnnotationType(item.annotationType)) return;
                // Add the annotation to the sources atom
                await store.set(updateSourcesFromZoteroItemsAtom, [item], true);
            }
            return;
        }
        
        // Check for file drops
        /* if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            
            for (const file of files) {
                // Check file size
                if (file.size > FILE_SIZE_LIMIT) {
                    showErrorMessage(`File too large: ${file.name}. Maximum size is 10MB.`);
                    continue;
                }
                
                // Check file type
                if (!VALID_MIME_TYPES.includes(file.type as any)) {
                    showErrorMessage(`Invalid file type: ${file.type}. Only PDF and PNG files are supported.`);
                    continue;
                }
                
                // Add file source
                addFileSource(file);
            }
        }*/
    };

    return (
        <div
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="relative"
            style={{ height: '100%', width: '100%' }}
        >
            {/* Drag overlay - always render but control visibility with opacity/transform */}
            <div
                className="absolute inset-0 display-flex items-center justify-center z-10 bg-quaternary border-popup"
                style={{ 
                    opacity: isDragging ? 0.8 : 0, 
                    borderRadius: '6px', 
                    transition: 'opacity 0.3s ease',
                    pointerEvents: isDragging ? 'auto' : 'none',
                    visibility: isDragging ? 'visible' : 'hidden'
                }}
            >
                <div className="display-flex flex-row items-start p-4 gap-4 ml-3">
                    {dragType === 'item' && objectIcon ? (
                        <div className="scale-12 mb-2">
                            <CSSItemTypeIcon itemType={objectIcon} />
                        </div>
                    ) : (
                        <div>
                            <ZoteroIcon 
                                icon={objectIcon || ZOTERO_ICONS.ATTACHMENTS} 
                                size={20}
                                color="--fill-primary"
                            />
                        </div>
                    )}
                    <div className="text-lg">
                        {dragType === 'annotation' 
                            ? `Drop to add ${dragCount} annotation${dragCount !== 1 ? 's' : ''}` 
                            : `Drop to add ${dragCount} item${dragCount !== 1 ? 's' : ''}`}
                    </div>
                </div>
            </div>

            {/* Error message - also always render but control visibility */}
            <div
                className="absolute inset-0 display-flex items-center justify-center z-10"
                style={{ 
                    background: 'var(--color-background)', 
                    opacity: dragError ? 0.6 : 0, 
                    borderRadius: '6px', 
                    transition: 'opacity 0.3s ease',
                    pointerEvents: dragError ? 'auto' : 'none',
                    visibility: dragError ? 'visible' : 'hidden'
                }}
            >
                <div className="text-center p-4 font-color-red">
                    <div className="font-medium">{dragError || ''}</div>
                </div>
            </div>

            {children}
        </div>
    );
};

export default DragDropWrapper;