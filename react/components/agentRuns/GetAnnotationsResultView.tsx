import React, { useState, useEffect } from 'react';
import { ZoteroItemReference } from '../../types/zotero';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { logger } from '../../../src/utils/logger';
import {
    AnnotationRow,
    ResolvedAnnotation,
    resolveAnnotationRefs,
} from './annotationListShared';

interface GetAnnotationsResultViewProps {
    annotations: ZoteroItemReference[];
    totalCount: number;
    toolName: 'get_annotations' | 'find_annotations';
    attachmentId?: string | null;
}

/**
 * Renders the result of a get_annotations tool call.
 *
 * The backend dehydrates this tool's result and ships only ZoteroItemReference
 * entries in `metadata.summary.annotations`. We resolve each reference against
 * the local Zotero database to read its type, color, text, comment, page label
 * and tags. Clicking a row opens the annotation in the Zotero reader.
 */
export const GetAnnotationsResultView: React.FC<GetAnnotationsResultViewProps> = ({
    annotations,
    totalCount,
    toolName,
    attachmentId,
}) => {
    const [resolved, setResolved] = useState<ResolvedAnnotation[]>([]);
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const resolve = async () => {
            const items = await resolveAnnotationRefs(annotations);
            if (!cancelled) setResolved(items);
        };
        resolve();
        return () => { cancelled = true; };
    }, [annotations]);

    if (annotations.length === 0) {
        return (
            <div className="p-3 text-sm font-color-secondary">
                No annotations found
            </div>
        );
    }

    const handleClick = async (annotation: ResolvedAnnotation) => {
        try {
            await navigateToAnnotation(annotation.item);
        } catch (error) {
            logger(`GetAnnotationsResultView: failed to navigate to ${annotation.ref.library_id}-${annotation.ref.zotero_key}: ${error}`, 1);
        }
    };
    const variant = toolName === 'find_annotations' && !attachmentId
        ? 'with-parent'
        : 'compact';

    return (
        <div className="display-flex flex-col min-w-0">
            {resolved.map((annotation) => {
                const key = `${annotation.ref.library_id}-${annotation.ref.zotero_key}`;
                return (
                    <AnnotationRow
                        key={key}
                        annotation={annotation}
                        variant={variant}
                        isHovered={hoveredId === key}
                        onMouseEnter={() => setHoveredId(key)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={() => handleClick(annotation)}
                    />
                );
            })}
        </div>
    );
};

export default GetAnnotationsResultView;
