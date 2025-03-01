// @ts-ignore no idea
import React, { useState, useRef } from 'react';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { FILE_SIZE_LIMIT, VALID_MIME_TYPES } from '../utils/resourceUtils';

interface DragDropWrapperProps {
    children: React.ReactNode;
    addFileSource: (file: File) => void;
}

const DragDropWrapper: React.FC<DragDropWrapperProps> = ({ 
    children,
    addFileSource
}) => {
    // Drag and drop states
    const [isDragging, setIsDragging] = useState(false);
    const [dragError, setDragError] = useState<string | null>(null);
    const dragErrorTimeoutRef = useRef<number | null>(null);

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

    // Handle drag events
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Check if either files or Zotero items
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('zotero/item')) {
            e.dataTransfer.dropEffect = 'copy';
            setIsDragging(true);
        }
    };

    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Check if either files or Zotero items
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('zotero/item')) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Check if the drag is leaving the entire container
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragging(false);
        }
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        // Check for Zotero items (disabled because sources are updated on selection)
        /*if (e.dataTransfer.types.includes('zotero/item')) {
            const itemIDs = e.dataTransfer.getData('zotero/item');
            if (itemIDs) {
                // Convert comma-separated IDs to an array of integers
                const ids = itemIDs.split(',').map(id => parseInt(id));
                
                try {
                    // Get the Zotero items
                    const items = Zotero.Items.get(ids);
                    
                    // Create ZoteroSources for each item
                    for (const item of items) {
                        // Create a source with pinned set to true
                        const source = await createZoteroSource(item, true);
                        // Add source directly to the sources atom
                        const currentSources = [...sources];
                        // Check if source already exists
                        const exists = currentSources.some(
                            (res) => res.type === 'zotero_item' && 
                                res.libraryID === source.libraryID && 
                                res.itemKey === source.itemKey
                        );
                        if (!exists) {
                            currentSources.push(source);
                            // Update sources atom
                            setSources(currentSources);
                        }
                        // if (!exists) {
                    }
                } catch (error) {
                    console.error('Error processing Zotero items:', error);
                }
            }
            return;
        }*/
        
        // Check for file drops
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
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
        }
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
            {/* Drag overlay */}
            {isDragging && (
                <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: 'var(--color-background)', opacity: 0.8, borderRadius: '6px', transition: 'all 0.3s ease' }}>
                    <div className="text-center p-4">
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.ATTACHMENTS} 
                            size={28} 
                            color="--fill-primary"
                            className="mb-2 mx-auto"
                        />
                        <div className="font-medium">Drop to add local files</div>
                        <div className="text-sm font-color-tertiary">Supported file types: PDF, PNG</div>
                    </div>
                </div>
            )}

            {/* Error message */}
            {dragError && (
                <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: 'var(--color-background)', opacity: 0.8, borderRadius: '6px', transition: 'all 0.3s ease' }}>
                    <div className="text-center p-4 font-color-red">
                        {dragError}
                    </div>
                </div>
            )}

            {children}
        </div>
    );
};

export default DragDropWrapper; 