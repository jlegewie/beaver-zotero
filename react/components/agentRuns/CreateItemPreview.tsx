import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import ReferenceMetadataDisplay from '../externalReferences/ReferenceMetadataDisplay';
import { CreateItemProposedData, CreateItemResultData } from '../../types/agentActions/items';
import { 
    externalReferenceItemMappingAtom,
    checkExternalReferenceAtom,
    isCheckingReferenceObjectAtom,
} from '../../atoms/externalReferences';
import { Spinner, CheckmarkCircleIcon, Icon } from '../icons/icons';
import { revealSource } from '../../utils/sourceUtils';
import ActionButtons from '../externalReferences/actionButtons';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface CreateItemPreviewProps {
    /** The proposed data containing the item to create */
    proposedData: CreateItemProposedData;
    /** Result data (when status is 'applied') */
    resultData?: CreateItemResultData;
    /** Current status of the action */
    status?: ActionStatus;
}

/**
 * Preview component for create_item actions in the deferred tool workflow.
 * Shows item metadata and indicates if item already exists in library.
 */
export const CreateItemPreview: React.FC<CreateItemPreviewProps> = ({
    proposedData,
    resultData,
    status = 'pending',
}) => {
    // Handle both validation format and execution format:
    // - During validation/awaiting: actionData contains { items: [], collections: [], tags: [] }
    // - After execution: proposed_data contains { item: {...}, collection_keys: [], suggested_tags: [] }
    const item = proposedData.item || (proposedData as any).items?.[0];
    
    if (!item) {
        return (
            <div className="create-item-preview px-3 py-2 text-sm font-color-secondary">
                No item data available
            </div>
        );
    }
    
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';

    // Check if item already exists in library
    const externalReferenceCache = useAtomValue(externalReferenceItemMappingAtom);
    const checkReference = useSetAtom(checkExternalReferenceAtom);
    const isChecking = useAtomValue(isCheckingReferenceObjectAtom);
    
    const [existingItemRef, setExistingItemRef] = useState<{ library_id: number; zotero_key: string } | null>(null);
    const [isCheckingExists, setIsCheckingExists] = useState(false);

    // Check if item exists in library on mount
    useEffect(() => {
        const sourceId = item.source_id;
        if (!sourceId) return;

        // First check cache
        const cached = externalReferenceCache[sourceId];
        if (cached !== undefined) {
            setExistingItemRef(cached);
            return;
        }

        // If not cached, check
        if (!isChecking(item)) {
            setIsCheckingExists(true);
            checkReference(item).then(result => {
                setExistingItemRef(result);
                setIsCheckingExists(false);
            }).catch(() => {
                setIsCheckingExists(false);
            });
        }
    }, [item, externalReferenceCache, checkReference, isChecking]);

    // Determine text styling based on status
    const getTextClasses = (defaultClass: string = 'font-color-primary') => {
        if (isRejectedOrUndone) return 'font-color-tertiary line-through';
        if (isError) return 'font-color-tertiary';
        return defaultClass;
    };

    return (
        <div className="create-item-preview px-3 py-2">
            <div className="display-flex flex-col gap-2">
                {/* Item metadata */}
                <ReferenceMetadataDisplay
                    title={item.title}
                    authors={item.authors}
                    publicationTitle={item.journal?.name || item.venue}
                    year={item.year}
                    getTextClasses={getTextClasses}
                />

                {/* Action buttons */}
                <ActionButtons
                    item={item}
                    detailsButtonMode="icon-only"
                    webButtonMode="icon-only"
                    pdfButtonMode="icon-only"
                    revealButtonMode="full"
                    // importButtonMode="icon-only"
                />

                {/* Existing item indicator */}
                {isCheckingExists && (
                    <div className="display-flex items-center gap-2 text-sm font-color-secondary">
                        <Spinner className="scale-12" />
                        <span>Checking library...</span>
                    </div>
                )}
                
                {!isCheckingExists && existingItemRef && status === 'pending' && (
                    <div className="display-flex items-center gap-2 text-sm font-color-tertiary">
                        <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-11" />
                        <span>Already in library</span>
                        <button
                            type="button"
                            className="text-link-muted"
                            onClick={() => revealSource(existingItemRef)}
                        >
                            Reveal
                        </button>
                    </div>
                )}

                {/* Applied success indicator */}
                {/* {isApplied && appliedLibraryId && appliedZoteroKey && (
                    <div className="display-flex items-center gap-2 text-sm">
                        <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-11" />
                        <span className="font-color-secondary">Added to library</span>
                        <button
                            type="button"
                            className="text-link-muted display-flex items-center gap-1"
                            onClick={() => revealSource({ library_id: appliedLibraryId, zotero_key: appliedZoteroKey })}
                        >
                            <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={9} />
                            Reveal
                        </button>
                    </div>
                )} */}

                {/* Collections and tags info */}
                {/* {(() => {
                    // Handle both formats: collection_keys/suggested_tags (execution) or collections/tags (validation)
                    const collections = proposedData.collection_keys || (proposedData as any).collections;
                    const tags = proposedData.suggested_tags || (proposedData as any).tags;
                    
                    if (!collections?.length && !tags?.length) return null;
                    
                    return (
                        <div className="display-flex flex-col gap-1 text-sm font-color-secondary mt-1">
                            {collections && collections.length > 0 && (
                                <div>
                                    Collections: {collections.join(', ')}
                                </div>
                            )}
                            {tags && tags.length > 0 && (
                                <div>
                                    Tags: {tags.join(', ')}
                                </div>
                            )}
                        </div>
                    );
                })()} */}

                {/* Error message */}
                {/* {isError && (
                    <div className="text-sm color-error">
                        Failed to create item
                    </div>
                )} */}
            </div>
        </div>
    );
};

export default CreateItemPreview;
