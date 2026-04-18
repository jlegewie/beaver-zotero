import React, { useState, useRef } from 'react';
import { getPref } from '../../../src/utils/prefs';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { CSSItemTypeIcon, CSSIcon } from '../icons/zotero';
import { isValidAnnotationType } from '../../types/attachments/apiTypes';
import { addItemToCurrentMessageItemsAtom, addItemsToCurrentMessageItemsAtom, currentMessageFiltersAtom } from '../../atoms/messageComposition';
import { useSetAtom, useAtomValue } from 'jotai';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { getCurrentReader } from '../../utils/readerUtils';

interface DragDropWrapperProps {
    children: React.ReactNode;
}

const DragDropWrapper: React.FC<DragDropWrapperProps> = ({ 
    children
}) => {
    // Drag and drop states
    const [objectIcon, setObjectIcon] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragError, setDragError] = useState<string | null>(null);
    const [dragCount, setDragCount] = useState<number>(0);
    const [dragType, setDragType] = useState<'item' | 'annotation' | 'collection' | null>(null);
    const dragErrorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const addItemsToCurrentMessageItems = useSetAtom(addItemsToCurrentMessageItemsAtom);
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const setCurrentMessageFilters = useSetAtom(currentMessageFiltersAtom);

    const maxAddAttachmentToMessage = getPref('maxAddAttachmentToMessage') as number || 10;

    /**
     * Validate if a collection can be added as a filter
     * @param collection The collection to validate
     * @returns Object with valid status and optional error message
     */
    const validateCollection = (collection: Zotero.Collection): { valid: boolean; error?: string } => {
        // Check if collection is deleted
        if (collection.deleted) {
            return { valid: false, error: "Collection is deleted" };
        }
        // Check if collection is in a searchable library
        if (!searchableLibraryIds.includes(collection.libraryID)) {
            return { valid: false, error: "Collection is not in a synced library" };
        }
        return { valid: true };
    };

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

    // Zotero's reader sidebar doesn't set `zotero/annotation` on dragstart for area
    // annotations. The <img> preview triggers the browser's native image-drag, which
    // strips Zotero metadata. Detect this fallback shape via `text/_moz_htmlcontext`
    // containing `data-sidebar-annotation-id`, then resolve via the current reader's
    // selectedAnnotationIDs.
    const isSidebarAnnotationFallback = (e: React.DragEvent<HTMLDivElement>): boolean => {
        const types = e.dataTransfer.types;
        if (types.includes('zotero/annotation')) return false;
        if (!types.includes('text/_moz_htmlcontext')) return false;
        const htmlContext = e.dataTransfer.getData('text/_moz_htmlcontext');
        return !!htmlContext && htmlContext.includes('data-sidebar-annotation-id');
    };

    // _moz_htmlcontext carries the drag source's ancestor chain. Treat the innermost
    // data-sidebar-annotation-id as the authoritative drag source, so right-click drags
    // (or any drag where the element isn't pre-selected) still resolve correctly.
    const parseSidebarAnnotationKey = (e: React.DragEvent<HTMLDivElement>): string | null => {
        if (!e.dataTransfer.types.includes('text/_moz_htmlcontext')) return null;
        const htmlContext = e.dataTransfer.getData('text/_moz_htmlcontext');
        if (!htmlContext) return null;
        const matches = [...htmlContext.matchAll(/data-sidebar-annotation-id="([^"]+)"/g)];
        if (!matches.length) return null;
        return matches[matches.length - 1][1];
    };

    const getSidebarAnnotationKeys = (e: React.DragEvent<HTMLDivElement>): string[] => {
        const reader = getCurrentReader();
        if (!reader) return [];
        const selectedIds: string[] = reader._internalReader?._state?.selectedAnnotationIDs ?? [];
        const dragSourceKey = parseSidebarAnnotationKey(e);
        if (dragSourceKey) {
            // Multi-select drag: drag source is one of the selected annotations.
            // Otherwise (e.g. right-click drag), honor the drag source alone.
            return selectedIds.includes(dragSourceKey) ? selectedIds : [dragSourceKey];
        }
        return selectedIds;
    };

    const resolveSidebarAnnotationItems = async (e: React.DragEvent<HTMLDivElement>): Promise<Zotero.Item[]> => {
        const reader = getCurrentReader();
        if (!reader) return [];
        const keys = getSidebarAnnotationKeys(e);
        if (!keys.length) return [];
        const attachment = await Zotero.Items.getAsync(reader.itemID);
        if (!attachment) return [];
        const items: Zotero.Item[] = [];
        for (const key of keys) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.libraryID, key);
            if (item && item.isAnnotation() && isValidAnnotationType(item.annotationType)) {
                items.push(item);
            }
        }
        return items;
    };

    const getSidebarAnnotationPreview = (e: React.DragEvent<HTMLDivElement>): { count: number; annotationType: _ZoteroTypes.Annotations.AnnotationType | null } => {
        const reader = getCurrentReader();
        if (!reader) return { count: 0, annotationType: null };
        const keys = getSidebarAnnotationKeys(e);
        const annotations = reader._internalReader?._state?.annotations ?? [];
        const first = annotations.find((a: any) => keys.includes(a.id));
        return {
            count: keys.length,
            annotationType: first?.type ?? null
        };
    };

    // Handle drag events
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        const sidebarFallback = isSidebarAnnotationFallback(e);

        const itemCount = e.dataTransfer.types.includes('zotero/item')
            ? e.dataTransfer.getData('zotero/item').split(',').length
            : e.dataTransfer.types.includes('zotero/annotation')
            ? JSON.parse(e.dataTransfer.getData('zotero/annotation')).length
            : sidebarFallback
            ? getSidebarAnnotationPreview(e).count
            : 0;

        if (itemCount > maxAddAttachmentToMessage) {
            e.dataTransfer.dropEffect = 'none';
            if (isDragging) setIsDragging(false);
            showErrorMessage(`You can add up to ${maxAddAttachmentToMessage} items at a time.`);
            return;
        }

        // Set appropriate drop effect
        if (
            e.dataTransfer.types.includes('zotero/annotation') ||
            e.dataTransfer.types.includes('zotero/item') ||
            e.dataTransfer.types.includes('zotero/collection') ||
            sidebarFallback
        ) {
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
        
        // Handle Zotero collections
        else if (e.dataTransfer.types.includes('zotero/collection')) {
            try {
                const collectionData = e.dataTransfer.getData('zotero/collection');
                if (collectionData) {
                    const ids = collectionData.split(',').map(id => parseInt(id));
                    const validCollections = ids
                        .map(id => Zotero.Collections.get(id))
                        .filter((collection): collection is Zotero.Collection => {
                            if (!collection) return false;
                            const validation = validateCollection(collection);
                            return validation.valid;
                        });
                    
                    if (validCollections.length > 0) {
                        setObjectIcon(null); // We'll use CSSIcon for collections
                        setIsDragging(true);
                        setDragType('collection');
                        setDragCount(validCollections.length);
                    } else {
                        // All collections are invalid
                        const firstCollection = ids.length > 0 ? Zotero.Collections.get(ids[0]) : null;
                        if (firstCollection) {
                            const validation = validateCollection(firstCollection);
                            showErrorMessage(validation.error || "Collection not supported");
                        } else {
                            showErrorMessage("Collection not found");
                        }
                        e.dataTransfer.dropEffect = 'none';
                    }
                }
            } catch (error) {
                console.error("Error handling collection data:", error);
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

        else if (sidebarFallback) {
            const { count, annotationType } = getSidebarAnnotationPreview(e);
            if (count > 0) {
                setObjectIcon(getObjectIcon(annotationType ?? 'image'));
                setIsDragging(true);
                setDragType('annotation');
                setDragCount(count);
            }
        }
    };

    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        const sidebarFallback = isSidebarAnnotationFallback(e);

        const itemCount = e.dataTransfer.types.includes('zotero/item')
            ? e.dataTransfer.getData('zotero/item').split(',').length
            : e.dataTransfer.types.includes('zotero/annotation')
            ? JSON.parse(e.dataTransfer.getData('zotero/annotation')).length
            : sidebarFallback
            ? getSidebarAnnotationPreview(e).count
            : 0;

        if (itemCount > maxAddAttachmentToMessage) {
            e.dataTransfer.dropEffect = 'none';
            if (isDragging) setIsDragging(false);
            showErrorMessage(`You can add up to ${maxAddAttachmentToMessage} items at a time.`);
            return;
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
        
        // Handle Zotero collections
        else if (e.dataTransfer.types.includes('zotero/collection')) {
            try {
                const collectionData = e.dataTransfer.getData('zotero/collection');
                if (collectionData) {
                    const ids = collectionData.split(',').map(id => parseInt(id));
                    const validCollections = ids
                        .map(id => Zotero.Collections.get(id))
                        .filter((collection): collection is Zotero.Collection => {
                            if (!collection) return false;
                            const validation = validateCollection(collection);
                            return validation.valid;
                        });
                    
                    if (validCollections.length > 0) {
                        setObjectIcon(null);
                        setIsDragging(true);
                        setDragType('collection');
                        setDragCount(validCollections.length);
                    } else {
                        const firstCollection = ids.length > 0 ? Zotero.Collections.get(ids[0]) : null;
                        if (firstCollection) {
                            const validation = validateCollection(firstCollection);
                            showErrorMessage(validation.error || "Collection not supported");
                        } else {
                            showErrorMessage("Collection not found");
                        }
                    }
                }
            } catch (error) {
                console.error("Error handling collection data:", error);
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

        else if (sidebarFallback) {
            const { count, annotationType } = getSidebarAnnotationPreview(e);
            if (count > 0) {
                setObjectIcon(getObjectIcon(annotationType ?? 'image'));
                setIsDragging(true);
                setDragType('annotation');
                setDragCount(count);
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

        const sidebarFallback = isSidebarAnnotationFallback(e);

        // Do not proceed if the number of items is too large
        const itemCount = e.dataTransfer.types.includes('zotero/item')
            ? e.dataTransfer.getData('zotero/item').split(',').length
            : e.dataTransfer.types.includes('zotero/annotation')
            ? JSON.parse(e.dataTransfer.getData('zotero/annotation')).length
            : sidebarFallback
            ? getSidebarAnnotationPreview(e).count
            : 0;

        if (itemCount > maxAddAttachmentToMessage) {
            showErrorMessage(`You can add up to ${maxAddAttachmentToMessage} items at a time.`);
            return;
        }

        // Handle Zotero items
        if (e.dataTransfer.types.includes('zotero/item')) {
            const itemIDs = e.dataTransfer.getData('zotero/item');
            if (itemIDs) {
                // Convert comma-separated IDs to an array of integers
                const ids = itemIDs.split(',').map(id => parseInt(id));
                const items = await Zotero.Items.getAsync(ids);
                
                // Add items to current message items
                await addItemsToCurrentMessageItems(items);
            }
            return;
        }

        // Handle Zotero collections
        if (e.dataTransfer.types.includes('zotero/collection')) {
            const collectionData = e.dataTransfer.getData('zotero/collection');
            if (collectionData) {
                const ids = collectionData.split(',').map(id => parseInt(id));
                const validCollections = ids
                    .map(id => Zotero.Collections.get(id))
                    .filter((collection): collection is Zotero.Collection => {
                        if (!collection) return false;
                        const validation = validateCollection(collection);
                        return validation.valid;
                    });
                
                if (validCollections.length === 0) {
                    showErrorMessage("No valid collections to add");
                    return;
                }
                
                // Add valid collection IDs to the message filters
                // Following the same pattern as AddSourcesMenu.handleSelectCollection
                const validCollectionIds = validCollections.map(c => c.id);
                setCurrentMessageFilters((prev) => ({
                    ...prev,
                    libraryIds: [],
                    collectionIds: [...new Set([...prev.collectionIds, ...validCollectionIds])],
                    tagSelections: []
                }));
            }
            return;
        }

        // Handle Zotero annotations
        if (e.dataTransfer.types.includes("zotero/annotation")) {
            const annotationData = JSON.parse(e.dataTransfer.getData('zotero/annotation'));
            for (const data of annotationData) {
                const attachment = Zotero.Items.get(data.attachmentItemID);
                const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.libraryID, data.id);
                // Skip if item is not an annotation or has an invalid annotation type
                if(!item || !item.isAnnotation() || !isValidAnnotationType(item.annotationType)) continue;
                // Add the annotation to the current message items
                await addItemToCurrentMessageItems(item);
            }
            return;
        }

        // Fallback for area annotations dragged from the reader sidebar, where Zotero's
        // <img> preview triggers the browser's native image-drag and drops `zotero/annotation`.
        // Resolve from the current reader's selected annotation IDs instead.
        if (sidebarFallback) {
            const items = await resolveSidebarAnnotationItems(e);
            if (!items.length) {
                showErrorMessage("Annotation not supported");
                return;
            }
            for (const item of items) {
                await addItemToCurrentMessageItems(item);
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
            style={{ width: '100%' }}
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
                    ) : dragType === 'collection' ? (
                        <div className="scale-12 mb-2">
                            <CSSIcon name="collection" className="icon-16" />
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
                            ? `Drop here to add ${dragCount} annotation${dragCount !== 1 ? 's' : ''}` 
                            : dragType === 'collection'
                            ? `Drop here to filter by ${dragCount} collection${dragCount !== 1 ? 's' : ''}`
                            : `Drop here to add ${dragCount} item${dragCount !== 1 ? 's' : ''}`}
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