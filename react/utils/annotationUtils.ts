import { getCurrentReader } from "./readerUtils";

/**
* Types for the Zotero Reader API
*/
interface ZoteroReader {
    _internalReader: {
        _annotationManager: {
            addAnnotation: (data: any) => Promise<Annotation>;
            updateAnnotations: (data: any) => Promise<void>;
            getAnnotations: () => Promise<Annotation[]>;
        };
        navigate: (options: NavigationOptions) => Promise<void>;
        unsetAnnotations: (ids: any) => Promise<void>;
    };
    _iframeWindow: Window;
}

/**
* Type for an annotation in Zotero
*/
interface Annotation {
    id: string;
    type: 'highlight' | 'note' | 'image' | 'ink' | 'underline' | 'text';
    color: string;
    sortIndex: string;
    comment?: string;
    position: {
        pageIndex: number;
        rects: number[][];
    };
    temporary?: boolean;
}

/**
* Type for annotation creation options
*/
interface CreateAnnotationOptions {
    pageIndex: number;
    rect: number[];
    color?: string;
    comment?: string;
    temporary?: boolean;
}

/**
* Type for temporary annotation options
*/
interface TemporaryAnnotationOptions extends CreateAnnotationOptions {
    timeout?: number;
}

/**
* Type for annotation modification options
*/
interface ModifyAnnotationOptions {
    pageIndex?: number;
    rect?: number[];
    color?: string;
    comment?: string;
}

/**
* Type for navigation options
*/
interface NavigationOptions {
    annotationId?: string;
    pageIndex?: number;
    position?: any;
}

/**
* Utility functions for working with image annotations in Zotero Reader
*/
const ZoteroImageAnnotations = {
    /**
    * Create a new image annotation for a specific rectangle
    * 
    * @param options - Annotation options
    * @returns The created annotation object with its ID
    */
    async createImageAnnotation({
        pageIndex,
        rect,
        color = '#ffd400',
        comment = '',
        temporary = false
    }: CreateAnnotationOptions): Promise<Annotation> {
        const reader = getCurrentReader() as unknown as ZoteroReader;
        if (!reader || !reader._internalReader) {
            throw new Error('No active reader found');
        }
        
        // Generate a sort index for proper ordering
        // Format: pageIndex|yPosition|xPosition (padded with zeros)
        const sortIndex = this._generateSortIndex(pageIndex, rect);
        
        // Create the annotation object
        const annotationData: Omit<Annotation, 'id'> = {
            type: 'image',
            color: color,
            sortIndex: sortIndex,
            comment: comment,
            position: {
                pageIndex: pageIndex,
                rects: [rect]
            },
            temporary: temporary
        };
        
        // Add the annotation to the reader
        const annotation = await reader._internalReader._annotationManager.addAnnotation(
            Components.utils.cloneInto(annotationData, reader._iframeWindow)
        );
        
        return annotation;
    },
    
    /**
    * Modify an existing image annotation
    * 
    * @param id - The annotation ID
    * @param changes - The changes to apply
    * @returns The updated annotation
    */
    async modifyImageAnnotation(id: string, changes: ModifyAnnotationOptions = {}): Promise<Partial<Annotation>> {
        const reader = getCurrentReader() as unknown as ZoteroReader;
        if (!reader || !reader._internalReader) {
            throw new Error('No active reader found');
        }
        
        // Create update object with id
        const updateData: Partial<Annotation> = { id };
        
        // Add changes to the update object
        if (changes.color) updateData.color = changes.color;
        if (changes.comment) updateData.comment = changes.comment;
        
        // Handle position changes
        if (changes.pageIndex !== undefined || changes.rect) {
            // Get current annotation to merge with changes
            const currentAnnotations = await this.getAnnotations();
            const currentAnnotation = currentAnnotations.find(a => a.id === id);
            
            if (!currentAnnotation) {
                throw new Error(`Annotation with ID ${id} not found`);
            }
            
            const pageIndex = changes.pageIndex ?? currentAnnotation.position.pageIndex;
            const rect = changes.rect ?? currentAnnotation.position.rects[0];
            
            updateData.position = {
                pageIndex: pageIndex,
                rects: [rect]
            };
            
            // Update sort index if position changed
            updateData.sortIndex = this._generateSortIndex(pageIndex, rect);
        }
        
        // Update the annotation
        await reader._internalReader._annotationManager.updateAnnotations(
            Components.utils.cloneInto([updateData], reader._iframeWindow)
        );
        
        return updateData;
    },
    
    /**
    * Delete an image annotation
    * 
    * @param ids - The annotation ID(s) to delete
    */
    async deleteImageAnnotation(ids: string | string[]): Promise<void> {
        const reader = getCurrentReader() as unknown as ZoteroReader;
        if (!reader || !reader._internalReader) {
            throw new Error('No active reader found');
        }
        
        const idArray = Array.isArray(ids) ? ids : [ids];
        await reader._internalReader.unsetAnnotations(
            Components.utils.cloneInto(idArray, reader._iframeWindow)
        );
    },
    
    /**
    * Scroll to a specific annotation in the reader
    * 
    * @param id - The annotation ID to scroll to
    */
    async scrollToAnnotation(id: string): Promise<void> {
        const reader = getCurrentReader() as unknown as ZoteroReader;
        if (!reader || !reader._internalReader) {
            throw new Error('No active reader found');
        }
        
        // Navigate to the annotation's location
        await reader._internalReader.navigate({
            annotationId: id
        });
    },
    
    /**
    * Create a temporary image annotation that will be removed after a timeout
    * 
    * @param options - Annotation options including timeout
    * @returns The ID of the created annotation
    */
    async createTemporaryImageAnnotation({
        pageIndex,
        rect,
        color = '#ffd400',
        timeout = 2000
    }: TemporaryAnnotationOptions): Promise<string> {
        const annotation = await this.createImageAnnotation({
            pageIndex,
            rect,
            color,
            temporary: true
        });
        
        // Set timeout to automatically remove the annotation
        setTimeout(() => {
            this.deleteImageAnnotation(annotation.id).catch(e => 
                Zotero.debug(`Failed to delete temporary annotation: ${e}`)
            );
        }, timeout);
        
        return annotation.id;
    },
    
    /**
    * Get all annotations in the current reader
    * 
    * @returns List of all annotations
    */
    async getAnnotations(): Promise<Annotation[]> {
        const reader = getCurrentReader() as unknown as ZoteroReader;
        if (!reader || !reader._internalReader) {
            throw new Error('No active reader found');
        }
        
        return reader._internalReader._annotationManager.getAnnotations();
    },
    
    /**
    * Generate a sort index for an annotation based on its position
    * Format: pageIndex|yPosition|xPosition (padded with zeros)
    * 
    * @param pageIndex - 0-based page index
    * @param rect - Rectangle coordinates [x1, y1, x2, y2]
    * @returns Sort index string
    * @private
    */
    _generateSortIndex(pageIndex: number, rect: number[]): string {
        // Extract y position (second coordinate in rect)
        const yPos = Math.round(rect[1]);
        // Extract x position (first coordinate in rect)
        const xPos = Math.round(rect[0]);
        
        // Format: padded pageIndex|padded yPos|padded xPos
        return `${pageIndex.toString().padStart(5, '0')}|${yPos.toString().padStart(6, '0')}|${xPos.toString().padStart(5, '0')}`;
    }
};

/**
 * Example usage
 * 
 * const annotation = await ZoteroImageAnnotations.createImageAnnotation({
 *    pageIndex: 0,
 *    rect: [100, 200, 200, 300], // x1, y1, x2, y2
 *    color: '#ff9900',
 *    comment: 'Important area'
 * });
 * 
 * await ZoteroImageAnnotations.scrollToAnnotation(annotation.id);
 */
