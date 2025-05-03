import React, { useState, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { activePreviewAtom } from '../../atoms/ui';
import { readerAnnotationsAtom } from '../../atoms/input';
import { navigateToPage } from '../../utils/readerUtils';
import { Annotation } from '../../types/attachments/apiTypes';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { ANNOTATION_ICON_BY_TYPE } from '../AnnotationButton';
import Button from '../button';
import IconButton from '../IconButton';
import { CancelIcon, Icon } from '../icons';
import { InputSource } from '../../types/sources';
import { toAnnotation } from '../../types/attachments/converters';
import { getZoteroItem } from '../../utils/sourceUtils';

const ANNOTATION_TEXT_BY_TYPE = {
    highlight: 'Highlighted Text',
    underline: 'Underlined Text',
    note: 'Note Annotation',
    image: 'Selected Area',
}


interface AnnotationPreviewContentProps {
    attachment: InputSource;
    maxContentHeight: number;
}

const AnnotationPreviewContent: React.FC<AnnotationPreviewContentProps> = ({ attachment, maxContentHeight }) => {
    const setActivePreview = useSetAtom(activePreviewAtom);
    const setReaderAnnotations = useSetAtom(readerAnnotationsAtom);
    const [imagePath, setImagePath] = useState<string | null>(null);
    const [imageError, setImageError] = useState<boolean>(false);
    const [annotation, setAnnotation] = useState<Annotation | null>(null);
    const [annotationIcon, setAnnotationIcon] = useState<string | null>(null);
    const [annotationText, setAnnotationText] = useState<string | null>(null);

    useEffect(() => {
        const item = getZoteroItem(attachment);
        if (item) {
            const annotation = toAnnotation(item);
            if (annotation) {
                setAnnotation(annotation);
                setAnnotationIcon(ANNOTATION_ICON_BY_TYPE[annotation.annotation_type] || ZOTERO_ICONS.ANNOTATE_TEXT);
                setAnnotationText(ANNOTATION_TEXT_BY_TYPE[annotation.annotation_type] || 'Annotation');
            } else {
                setAnnotation(null);
                setAnnotationIcon(null);
                setAnnotationText(null);
            }
        } else {
            setAnnotation(null);
            setAnnotationIcon(null);
            setAnnotationText(null);
        }
    }, [attachment, setAnnotation, setAnnotationIcon, setAnnotationText]);

    // Fetch image path for image annotations
    useEffect(() => {
        if (!annotation || annotation.annotation_type !== 'image') return;
        let isMounted = true;
        const fetchImagePath = async () => {
            if (annotation.annotation_type === 'image') {
                try {
                    const annotationItem = { libraryID: annotation.library_id, key: annotation.zotero_key };
                    const hasCache = await Zotero.Annotations.hasCacheImage(annotationItem);
                    if (isMounted) {
                        if (hasCache) {
                            const path = Zotero.Annotations.getCacheImagePath(annotationItem);
                            setImagePath(Zotero.File.pathToFileURI(path));
                        } else {
                            console.warn(`Cache image not found for annotation: ${annotation.zotero_key}`);
                            setImageError(true); // Indicate missing image
                        }
                    }
                } catch (error) {
                    console.error("Error fetching annotation image path:", error);
                     if (isMounted) {
                        setImageError(true);
                     }
                }
            }
        };

        fetchImagePath();
        return () => { isMounted = false }; // Cleanup function to prevent state updates on unmounted component
    }, [annotation]);

    if (!annotation || !annotationIcon || !annotationText) return null;

    const handleRemove = () => {
        // Remove annotation state and close preview
        setReaderAnnotations((prev) => prev.filter((a) => a.zotero_key !== annotation.zotero_key));
        setActivePreview(null);
    };

    const handleGoToAnnotation = async () => {
        // TODO: implement navigation or selection function
        const itemId = Zotero.Items.getIDFromLibraryAndKey(annotation.library_id, annotation.parent_key);
        if (itemId) {
            navigateToPage(itemId, annotation.position.page_index + 1);
        }
    };

    const renderAnnotationContent = () => {
        switch (annotation.annotation_type) {
            case 'highlight':
            case 'underline':
                return (
                    <>
                        {annotation.text && <p className="text-base mb-2">{annotation.text}</p>}
                        {annotation.comment && (
                            <div className="annotation-comment border-top-quaternary pt-2 mt-2">
                                <p className="text-base">{annotation.comment}</p>
                            </div>
                        )}
                        {!annotation.text && !annotation.comment && <p className="font-color-tertiary italic">No text or comment</p>}
                    </>
                );
            case 'note':
                return annotation.comment ? <p className="text-base">{annotation.comment}</p> : <p className="font-color-tertiary italic">Empty note</p>;
            case 'image':
                if (imageError) {
                    return <p className="font-color-tertiary italic">Could not load image preview.</p>;
                }
                if (imagePath) {
                    return (
                        <div className="w-full h-full flex items-center justify-center overflow-hidden">
                            <img src={imagePath} alt="Annotation Image" className="max-w-full max-h-[calc(100%-2rem)] object-contain" />
                        </div>
                    );
                }
                return <p className="font-color-secondary italic">Loading image...</p>; // Loading indicator
            default:
                return <p className="font-color-secondary italic">Unsupported annotation type</p>;
        }
    };


    return (
        <>
            {/* Content Area */}
            <div
                className="source-content p-3"
                style={{ maxHeight: `${maxContentHeight}px`, overflowY: 'auto' }}
            >
                <div className="display-flex flex-row items-center gap-1 mb-2">
                    <ZoteroIcon icon={annotationIcon} size={14} />
                    <div className="font-color-primary">{annotationText}</div>
                    <div className="flex-1" />
                    {annotation.page_label && <div className="font-color-secondary">Page {annotation.page_label}</div>}
                </div>
                {renderAnnotationContent()}
            </div>

            {/* buttons */}
            <div className="p-2 pt-1 display-flex flex-row items-center border-top-quinary">
                <div className="flex-1 gap-3 display-flex">
                    <Button
                        variant="ghost"
                        onClick={handleGoToAnnotation}
                        disabled={!annotation.parent_key} // Disable if parent info is missing
                    >
                        <ZoteroIcon
                            icon={ZOTERO_ICONS.OPEN}
                            size={12}
                        />
                        Go to Annotation
                    </Button>
                    <Button
                        variant="ghost"
                        onClick={handleRemove}
                    >
                        <ZoteroIcon
                            icon={ZOTERO_ICONS.TRASH}
                            size={12}
                        />
                        Remove
                    </Button>
                </div>
                <div className="display-flex">
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost"
                        onClick={() => setActivePreview(null)}
                    />
                </div>
            </div>
        </>
    );
};

export default AnnotationPreviewContent;