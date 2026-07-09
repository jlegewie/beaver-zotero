import React, { useEffect, useState } from 'react';
import { CSSIcon, Icon, PlusSignIcon } from '../../../components/icons/icons';
import { getHost } from '../..';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

// Rows render full-width (flush to the card edges) so the hover highlight spans
// the whole row; content is inset via internal padding. Subcollections indent
// their content further to convey the parent → child hierarchy.
const ROW_PADDING = '12px';
const CHILD_ROW_PADDING = '32px';

interface CreateCollectionPreviewProps {
    /** Name of the collection to create */
    name: string;
    /** Resolved library id (from result_data, current_value, or action data) */
    libraryId?: number | null;
    /** Library name, used only to resolve the library when no id is available */
    libraryName?: string;
    /** Parent collection key (optional, for subcollections) */
    parentKey?: string | null;
    /** Number of items to add (from current_value or item_ids length) */
    itemCount?: number;
    /** Current status of the action */
    status?: ActionStatus;
    /** Result data (when status is 'applied') */
    resultData?: {
        collection_key?: string;
        collection_id?: number;
        items_added?: number;
    };
}

/**
 * Preview component for create_collection actions.
 * Shows details about the collection that will be created.
 */
export const CreateCollectionPreview: React.FC<CreateCollectionPreviewProps> = ({
    name,
    libraryId: libraryIdProp,
    libraryName,
    parentKey,
    itemCount = 0,
    status = 'pending',
    resultData,
}) => {
    const [parentName, setParentName] = useState<string | null>(null);
    // Resolved library id, used to reveal the collections in the library view.
    const [libraryId, setLibraryId] = useState<number | null>(null);
    const [hoveredRow, setHoveredRow] = useState<'new' | 'parent' | null>(null);

    useEffect(() => {
        if (typeof Zotero === 'undefined') return;

        try {
            // Prefer the explicit library id: the collection may live in a group
            // library, and name lookup is unavailable for stored actions (which
            // carry no current_value) and ambiguous across same-named libraries.
            let library = (libraryIdProp != null ? Zotero.Libraries.get(libraryIdProp) : undefined) || undefined;

            // Name match is case-insensitive to mirror the action handler's resolution.
            if (!library && libraryName) {
                library = Zotero.Libraries.getAll().find(
                    l => l.name.toLowerCase() === libraryName.toLowerCase()
                );
            }

            // Collections without any library reference belong to the user library.
            if (!library && libraryIdProp == null && !libraryName) {
                library = Zotero.Libraries.userLibrary;
            }

            if (library) {
                setLibraryId(library.libraryID);
                if (parentKey) {
                    const parent = Zotero.Collections.getByLibraryAndKey(library.libraryID, parentKey);
                    if (parent) {
                        setParentName(parent.name);
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to resolve collection library/parent name:', e);
        }
    }, [parentKey, libraryIdProp, libraryName]);

    const isApplied = status === 'applied';
    const isError = status === 'error';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';

    // Once the action is applied, the collections exist and can be revealed in
    // the library view. The newly created collection's key comes from resultData.
    const newCollectionKey = resultData?.collection_key;
    const canRevealNew = isApplied && !!newCollectionKey && libraryId != null;
    const canRevealParent = isApplied && !!parentKey && libraryId != null;

    const revealCollection = (collectionKey: string) => {
        if (libraryId == null) return;
        getHost().navigation?.revealCollection({ library_id: libraryId, zotero_key: collectionKey });
    };

    const getNewItemStyles = () => {
        if (isApplied) return 'bg-transparent';
        if (isRejectedOrUndone) return 'opacity-60';
        if (isError) return 'bg-red-50/10';
        // Pending state - highlight as new
        return 'bg-green-500/10';
    };

    return (
        <div className={`create-collection-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="display-flex flex-col">

                {/* Full-width clickable rows (flush to the card edges, content inset
                    via internal padding; subcollections indent their content). */}
                <div className="display-flex flex-col">
                    {/* Parent Collection (if exists) */}
                    {parentKey && (
                        <div
                            className={`display-flex flex-row items-center gap-2 py-1 transition-colors duration-150 ${canRevealParent ? 'cursor-pointer' : 'opacity-60'} ${canRevealParent && hoveredRow === 'parent' ? 'bg-quinary' : ''}`}
                            style={{ paddingLeft: ROW_PADDING, paddingRight: ROW_PADDING }}
                            onClick={canRevealParent ? () => revealCollection(parentKey) : undefined}
                            onMouseEnter={canRevealParent ? () => setHoveredRow('parent') : undefined}
                            onMouseLeave={canRevealParent ? () => setHoveredRow(null) : undefined}
                            title={canRevealParent ? 'Click to reveal in Zotero' : undefined}
                        >
                            <span className="scale-75 display-flex">
                                <CSSIcon name="collection" className="icon-16" />
                            </span>
                            <span className="text-sm font-color-primary truncate">
                                {parentName || 'Parent Collection'}
                            </span>
                        </div>
                    )}

                    {/* New Collection */}
                    <div
                        className={`display-flex flex-row items-center gap-2 py-15 transition-colors duration-150 ${canRevealNew ? 'cursor-pointer' : ''} ${canRevealNew ? (hoveredRow === 'new' ? 'bg-quinary' : 'bg-transparent') : getNewItemStyles()}`}
                        style={{ paddingLeft: parentKey ? CHILD_ROW_PADDING : ROW_PADDING, paddingRight: ROW_PADDING }}
                        onClick={canRevealNew ? () => revealCollection(newCollectionKey!) : undefined}
                        onMouseEnter={canRevealNew ? () => setHoveredRow('new') : undefined}
                        onMouseLeave={canRevealNew ? () => setHoveredRow(null) : undefined}
                        title={canRevealNew ? 'Click to reveal in Zotero' : undefined}
                    >
                        <span className="scale-75 display-flex">
                            <CSSIcon name="collection" className="icon-16" />
                        </span>
                        <span className="text-sm font-color-primary font-medium truncate flex-1">
                            {name}
                        </span>
                        {status === 'pending' && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-700 border border-green-500/20 whitespace-nowrap ml-2">
                                New
                            </span>
                        )}
                    </div>
                </div>


                {/* Footer Info */}
                {itemCount > 0 && (
                    <div
                        className="display-flex flex-col gap-1 items-start mt-2 mb-1 text-sm font-color-secondary"
                        style={{ paddingLeft: ROW_PADDING, paddingRight: ROW_PADDING }}
                    >
                        <div className="display-flex flex-row items-center gap-05">
                            <Icon icon={PlusSignIcon} className="scale-90" />
                            <span>
                                {isApplied && resultData?.items_added !== undefined && (
                                    <span className="ml-1">
                                        Added {resultData.items_added} item{resultData.items_added !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {!isApplied && itemCount && itemCount > 0 && (
                                    <span className="ml-1">
                                        Adding {itemCount} item{itemCount !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CreateCollectionPreview;
