import { logger } from "../../src/utils/logger";
import { BEAVER_ANNOTATION_AUTHOR } from '../../src/constants/annotations';
import { getCurrentReader } from "./readerUtils";
import { ZoteroItemReference } from "../types/zotero";
import { getPageViewportInfo } from './pdfUtils';
import {
    displayBoxToZoteroRect,
    sourceBboxesToZoteroRects,
} from '../../src/services/annotations/annotationGeometry';
import { getCurrentReaderAndWaitForView } from './readerUtils';
import type { BoundingBox } from '../types/citations';
import type { NotePosition } from '../types/agentActions/annotations';

const TEMPORARY_NOTE_RECT_SIZE = 18;
const TEMPORARY_NOTE_SIDE_MARGIN = 12;

/**
* Types for the Zotero Reader API
*/
export interface ZoteroReader {
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
    pageLabel?: string;
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
            pageLabel: (pageIndex + 1).toString(),
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
 * Global manager for temporary annotations created by Beaver
 */
export const BeaverTemporaryAnnotations = {
    // Track temporary annotation references globally (both database and temporary-only)
    _currentAnnotations: [] as ZoteroItemReference[],

    /**
     * Add annotation references to the tracking list
     * @param annotationReferences Array of annotation references to track
     */
    addToTracking(annotationReferences: ZoteroItemReference[]): void {
        logger(`BeaverTemporaryAnnotations: Adding to tracking ${annotationReferences.length} annotations`);
        this._currentAnnotations.push(...annotationReferences);
    },

    /**
     * Clean up all tracked temporary annotations
     * @param readerInstance The specific reader instance to clean up annotations from
     */
    async cleanupAll(readerInstance?: ZoteroReader): Promise<void> {
        if (this._currentAnnotations.length === 0) return;
        logger('BeaverTemporaryAnnotations: Cleaning up temporary annotations');
        
        try {
            // Split into database annotations and temporary-only annotations
            const annotationReferences = this._currentAnnotations;
            const allAnnotationIds = annotationReferences.map(reference => reference.zotero_key);
            
            // Erase database annotations from Zotero
            for (const reference of annotationReferences) {
                try {
                    const annotation = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
                    if (annotation) await annotation.eraseTx();
                } catch (error) {
                    console.warn(`Failed to erase database annotation ${reference.zotero_key}:`, error);
                }
            }

            // UI cleanup for all annotations (both database and temporary-only)
            const readers = readerInstance
                ? [readerInstance]
                : [
                    ...(Zotero.Reader as any)?._readers ?? [],
                    getCurrentReader(),
                ].filter(Boolean) as ZoteroReader[];
            const seenReaders = new Set<ZoteroReader>();
            for (const reader of readers) {
                if (!reader || seenReaders.has(reader) || !reader._internalReader) continue;
                seenReaders.add(reader);
                try {
                    await reader._internalReader.unsetAnnotations(
                        Components.utils.cloneInto(allAnnotationIds, reader._iframeWindow)
                    );
                } catch (error) {
                    console.warn('Failed to unset temporary annotations in reader:', error);
                }
            }
            
            logger(`BeaverTemporaryAnnotations: Successfully cleaned up ${annotationReferences.length} temporary annotations`);
        } catch (error) {
            console.error('BeaverTemporaryAnnotations: Failed to cleanup temporary annotations:', error);
        }
        
        this._currentAnnotations = [];
    },

    /**
     * Get count of currently tracked annotations
     */
    getCount(): number {
        return this._currentAnnotations.length;
    },

    /**
     * Clear tracking without cleaning up annotations (use when reader is already closed)
     */
    clearTracking(): void {
        this._currentAnnotations = [];
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


/**
 * Create temporary highlight annotations for extracted bounding boxes.
 * @returns Array of annotation references
 */
interface TemporaryHighlightLocation {
    pageIndex: number;
    boxes: BoundingBox[];
    /** PDF page label for this page; falls back to the page number when absent. */
    pageLabel?: string | null;
}

/**
 * Compute the stored Zotero rect for a temporary PDF note annotation preview.
 */
async function computeTemporaryNoteRect(reader: any, notePosition: NotePosition): Promise<number[]> {
    const { viewBox, rotation, width, height } = await getPageViewportInfo(reader, notePosition.page_index);
    const normalizedRotation = (((rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    const isQuarterTurn = normalizedRotation === 90 || normalizedRotation === 270;
    const displayWidth = isQuarterTurn ? height : width;
    const displayHeight = isQuarterTurn ? width : height;
    const x = notePosition.side === 'right'
        ? displayWidth - TEMPORARY_NOTE_RECT_SIZE - TEMPORARY_NOTE_SIDE_MARGIN
        : TEMPORARY_NOTE_SIDE_MARGIN;
    const yTop = notePosition.coord_origin === 't'
        ? notePosition.y - TEMPORARY_NOTE_RECT_SIZE / 2
        : displayHeight - notePosition.y - TEMPORARY_NOTE_RECT_SIZE / 2;

    return displayBoxToZoteroRect(
        {
            l: x,
            t: yTop,
            r: x + TEMPORARY_NOTE_RECT_SIZE,
            b: yTop + TEMPORARY_NOTE_RECT_SIZE,
        },
        {
            viewBox: [viewBox[0], viewBox[1], viewBox[2], viewBox[3]] as [number, number, number, number],
            width,
            height,
            rotation: normalizedRotation,
        },
    );
}

/**
 * Create a temporary note annotation at the proposed PDF page position.
 * @returns Array with the temporary annotation reference, or empty on failure.
 */
export const createTemporaryNoteAnnotation = async (
    notePosition: NotePosition,
    comment: string,
    options: { color?: string; pageLabel?: string | null } = {},
): Promise<ZoteroItemReference[]> => {
    try {
        const reader = await getCurrentReaderAndWaitForView();
        if (!reader || !reader._internalReader || !reader._iframeWindow) {
            logger('createTemporaryNoteAnnotation: No active reader found for creating note preview');
            return [];
        }

        const rect = await computeTemporaryNoteRect(reader, notePosition);
        if (!Array.isArray(rect) || rect.length !== 4 || rect.some(value => !Number.isFinite(value))) {
            return [];
        }

        const pageIndex = notePosition.page_index;
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const color = options.color ?? '#ffd400';
        const sortIndex = `${pageIndex.toString().padStart(5, '0')}|${Math.round(rect[1]).toString().padStart(6, '0')}|${Math.round(rect[0]).toString().padStart(5, '0')}`;
        const now = new Date().toISOString();
        const pageLabel = options.pageLabel ?? (pageIndex + 1).toString();

        const tempAnnotation = {
            id: tempId,
            key: tempId,
            libraryID: reader._item.libraryID,
            type: 'note',
            color,
            sortIndex,
            position: {
                pageIndex,
                rects: [rect],
            },
            tags: [],
            comment,
            authorName: 'Beaver',
            pageLabel,
            isExternal: false,
            readOnly: false,
            lastModifiedByUser: '',
            dateModified: now,
            annotationType: 'note',
            annotationAuthorName: BEAVER_ANNOTATION_AUTHOR,
            annotationComment: comment,
            annotationColor: color,
            annotationPageLabel: pageLabel,
            annotationSortIndex: sortIndex,
            annotationPosition: JSON.stringify({
                pageIndex,
                rects: [rect],
            }),
            annotationIsExternal: false,
            isTemporary: true,
        };

        reader._internalReader.setAnnotations(
            Components.utils.cloneInto([tempAnnotation], reader._iframeWindow)
        );

        return [{
            zotero_key: tempId,
            library_id: reader._item.libraryID,
        }];
    } catch (error) {
        logger('createTemporaryNoteAnnotation: Failed to create note preview: ' + error);
        return [];
    }
};

export const createBoundingBoxHighlights = async (
    boundingBoxData: TemporaryHighlightLocation[],
    previewText: string,
    annotationText: string,
    options: { color?: string } = {},
): Promise<ZoteroItemReference[]> => {
    if (boundingBoxData.length === 0) return [];
    
    try {
        // Wait for PDF document to be loaded (required for getPageViewportInfo)
        const reader = await getCurrentReaderAndWaitForView(undefined, true);
        if (!reader || !reader._internalReader) {
            logger('createBoundingBoxHighlights: No active reader found for creating bounding box highlights');
            return [];
        }

        const tempAnnotations: any[] = [];
        const annotationReferences: ZoteroItemReference[] = [];
        
        const pageGroups = new Map<number, BoundingBox[][]>();
        const pageLabels = new Map<number, string | null>();
        for (const { pageIndex, boxes, pageLabel } of boundingBoxData) {
            if (!pageGroups.has(pageIndex)) {
                pageGroups.set(pageIndex, []);
            }
            pageGroups.get(pageIndex)!.push(boxes);
            // First non-blank label seen for the page wins; entries on the same
            // page carry the same label.
            if (!pageLabels.get(pageIndex) && typeof pageLabel === 'string' && pageLabel.trim() !== '') {
                pageLabels.set(pageIndex, pageLabel);
            }
        }

        const color = options.color ?? '#00bbff';

        // Create one annotation per page with combined rects
        for (const [pageIndex, allBboxesOnPage] of pageGroups) {
            const pageLabel = pageLabels.get(pageIndex) ?? (pageIndex + 1).toString();
            const { viewBox, rotation, width, height } = await getPageViewportInfo(reader, pageIndex);
            const geometry = {
                viewBox: [viewBox[0], viewBox[1], viewBox[2], viewBox[3]] as [number, number, number, number],
                width,
                height,
                rotation: (((rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270,
            };

            const rects = sourceBboxesToZoteroRects(allBboxesOnPage.flat(), geometry);
            if (rects.length === 0) continue;
            
            // Create unique IDs for the temporary annotation
            const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const tempKey = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Create properly structured annotation object matching Zotero.Annotations.toJSON() output
            const tempAnnotation = {
                // Core identification
                id: tempId,
                key: tempKey,
                libraryID: reader._item.libraryID,
                
                // Required annotation properties
                type: 'highlight',
                color,
                sortIndex: `${pageIndex.toString().padStart(5, '0')}|000000|00000`,
                position: {
                    pageIndex: pageIndex,
                    rects: rects
                },
                
                // Critical properties to prevent crashes - MUST be present
                tags: [],
                comment: '',
                text: previewText,
                authorName: 'Beaver',
                pageLabel,
                isExternal: false,
                readOnly: false,
                lastModifiedByUser: '',
                dateModified: new Date().toISOString(),
                
                // Backup annotation properties
                annotationType: 'highlight',
                annotationAuthorName: BEAVER_ANNOTATION_AUTHOR,
                annotationText: annotationText,
                annotationComment: '',
                annotationColor: color,
                annotationPageLabel: pageLabel,
                annotationSortIndex: `${pageIndex.toString().padStart(5, '0')}|000000|00000`,
                annotationPosition: JSON.stringify({
                    pageIndex: pageIndex,
                    rects: rects
                }),
                annotationIsExternal: false,
                
                // Mark as temporary so it doesn't get saved to database
                isTemporary: true
            };
            
            tempAnnotations.push(tempAnnotation);
            
            // Create reference for tracking
            annotationReferences.push({
                zotero_key: tempId,
                library_id: reader._item.libraryID
            });
        }
        
        // Add temporary annotations directly to reader display (no database save)
        if (tempAnnotations.length > 0) {
            reader._internalReader.setAnnotations(
                Components.utils.cloneInto(tempAnnotations, reader._iframeWindow)
            );
        }
        
        return annotationReferences;
    } catch (error) {
        logger('createBoundingBoxHighlights: Failed to create bounding box highlights: ' + error);
        return [];
    }
};
