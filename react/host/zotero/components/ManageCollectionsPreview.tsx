import React, { useEffect, useState } from 'react';
import { CSSIcon, Icon, ArrowRightIcon } from '../../../components/icons/icons';
import type { ManageCollectionsResultData } from '../../../types/agentActions/base';
import { shortenActionError } from './agentActionViewHelpers';
import { resolveLibraryRef } from '../../../../src/utils/libraryIdentity';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface ManageCollectionsPreviewProps {
    actionData: {
        action?: 'rename' | 'move' | 'delete';
        collection_key?: string;
        new_name?: string | null;
        new_parent_key?: string | null;
        library_id?: number;
        library_ref?: string;
    };
    currentValue?: {
        library_id?: number;
        library_name?: string;
        collection_name?: string;
        old_name?: string;
        old_parent_key?: string | null;
        old_item_count?: number;
    };
    status?: ActionStatus;
    resultData?: ManageCollectionsResultData;
    /** Server-provided error detail when status === 'error' */
    errorMessage?: string;
}

const CollectionPill: React.FC<{ name: string; strike?: boolean }> = ({ name, strike }) => (
    <span
        className="inline-flex items-center gap-1 text-sm font-color-primary"
        style={strike ? { textDecoration: 'line-through', opacity: 0.8 } : undefined}
    >
        <span className="scale-75 display-flex">
            <CSSIcon name="collection" className="icon-16" />
        </span>
        <span className="truncate">{name}</span>
    </span>
);

interface Fallback {
    libraryName?: string;
    collectionName?: string;
    oldParentKey?: string | null;
    oldItemCount?: number;
}

/**
 * Resolve the pre-action collection snapshot shown by the preview.
 *
 * Persisted result data is authoritative once an action has been applied.
 * Live Zotero data is only a legacy/rejected-action fallback because it may
 * already reflect the rename or move being previewed.
 */
export function resolveManageCollectionsSnapshot(
    currentValue: ManageCollectionsPreviewProps['currentValue'],
    resultData: ManageCollectionsResultData | undefined,
    fallback: Fallback,
): { collectionName: string; oldParentKey: string | null } {
    return {
        collectionName:
            currentValue?.collection_name
            ?? currentValue?.old_name
            ?? resultData?.old_name
            ?? fallback.collectionName
            ?? '(unknown)',
        oldParentKey: currentValue?.old_parent_key !== undefined
            ? currentValue.old_parent_key
            : resultData?.old_parent_key !== undefined
                ? resultData.old_parent_key
                : fallback.oldParentKey ?? null,
    };
}

function buildCollectionErrorText(
    action: 'rename' | 'move' | 'delete',
    errorMessage: string | undefined,
): string {
    const verb = action === 'delete' ? 'delete' : action === 'move' ? 'move' : 'rename';
    const base = `Failed to ${verb} collection`;
    if (!errorMessage) return `${base}.`;
    const m = errorMessage.toLowerCase();
    if (m.includes('subcollection')) return `${base} because it contains subcollections.`;
    if (m.includes('not found') || m.includes('no longer exists') || m.includes('permanently deleted')) {
        return `${base} because it no longer exists.`;
    }
    return `${base}. ${shortenActionError(errorMessage)}.`;
}

/**
 * Preview component for manage_collections actions.
 * The outer AgentActionView header already shows the operation summary,
 * so this body focuses on visual context + impact (library, item count, warnings).
 */
export const ManageCollectionsPreview: React.FC<ManageCollectionsPreviewProps> = ({
    actionData,
    currentValue,
    status = 'pending',
    resultData,
    errorMessage,
}) => {
    const action: 'rename' | 'move' | 'delete' = actionData.action ?? 'rename';
    const newName = actionData.new_name ?? undefined;
    const newParentKey = actionData.new_parent_key ?? null;
    const libraryId = resolveLibraryRef({
        library_ref: resultData?.library_ref ?? actionData.library_ref,
        library_id: resultData?.library_id ?? currentValue?.library_id ?? actionData.library_id,
    });
    const collectionKey = actionData.collection_key;

    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';

    // currentValue is only available while awaiting approval. After a final
    // state it is gone. Persisted resultData supplies the authoritative
    // pre-action snapshot for applied actions; live Zotero lookups fill in
    // library/impact context and support rejected or legacy actions.
    const [fallback, setFallback] = useState<Fallback>({});
    const [newParentName, setNewParentName] = useState<string | null>(null);
    const [oldParentName, setOldParentName] = useState<string | null>(null);

    useEffect(() => {
        if (currentValue || typeof Zotero === 'undefined' || libraryId == null || !collectionKey) return;
        let cancelled = false;
        (async () => {
            try {
                const lib = Zotero.Libraries.get(libraryId) as Zotero.Library | false;
                const collectionResult = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collectionKey);
                const collection = collectionResult || null;
                if (cancelled) return;
                const oldItemCount = collection
                    ? (collection.getChildItems(true, false) as number[]).length
                    : undefined;
                setFallback({
                    libraryName: lib ? lib.name : undefined,
                    collectionName: collection ? collection.name : undefined,
                    oldParentKey: collection && collection.parentKey ? String(collection.parentKey) : null,
                    oldItemCount,
                });
            } catch {
                // ignore — preview is best-effort
            }
        })();
        return () => { cancelled = true; };
    }, [currentValue, libraryId, collectionKey, status]);

    const { collectionName, oldParentKey } = resolveManageCollectionsSnapshot(
        currentValue,
        resultData,
        fallback,
    );
    const libraryName = currentValue?.library_name ?? fallback.libraryName;
    const itemCount =
        resultData?.items_affected
        ?? currentValue?.old_item_count
        ?? fallback.oldItemCount
        ?? 0;

    useEffect(() => {
        if (typeof Zotero === 'undefined' || libraryId == null) return;
        const resolve = async (key: string | null, setter: (s: string | null) => void) => {
            if (!key) { setter(null); return; }
            try {
                const c = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, key);
                setter(c ? c.name : key);
            } catch {
                setter(key);
            }
        };
        resolve(newParentKey, setNewParentName);
        resolve(oldParentKey, setOldParentName);
    }, [libraryId, newParentKey, oldParentKey]);

    return (
        <div className={`manage-collections-preview overflow-hidden`}>
            <div className="display-flex flex-col px-3 py-2 gap-2">
                <div className="display-flex flex-row items-center gap-2 flex-wrap">
                    {action === 'delete' && (
                        <span className="display-flex">
                            {isApplied ? 'Deleted' : 'Delete'}
                        </span>
                    )}
                    <CollectionPill name={collectionName} strike={isApplied && action === 'delete'} />
                    {action === 'rename' && newName && (
                        <>
                            <span className="scale-75 display-flex opacity-60">
                                <Icon icon={ArrowRightIcon} className="icon-16" />
                            </span>
                            <CollectionPill name={newName} />
                        </>
                    )}
                    {action === 'move' && (
                        <>
                            <span className="scale-75 display-flex opacity-60">
                                <Icon icon={ArrowRightIcon} className="icon-16" />
                            </span>
                            <CollectionPill name={newParentKey ? (newParentName ?? newParentKey) : 'Library top level'} />
                        </>
                    )}
                </div>

                <div className="display-flex flex-col gap-1 text-sm font-color-secondary">
                    {libraryName && (
                        <div>
                            <span className="font-color-primary">Library:</span> {libraryName}
                            {action === 'delete' && itemCount > 0 && (
                                <span>
                                    {' '}({itemCount} item{itemCount !== 1 ? 's' : ''} affected)
                                </span>
                            )}
                        </div>
                    )}
                    {action === 'move' && oldParentKey && (
                        <div>
                            <span className="font-color-primary">Was under:</span> {oldParentName ?? oldParentKey}
                        </div>
                    )}
                    {isError && (
                        <div className="font-color-red">
                            {buildCollectionErrorText(action, errorMessage)}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ManageCollectionsPreview;
