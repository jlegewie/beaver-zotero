import React from 'react';
import type { AnnotationPreviewSnapshot } from '@beaver/agent-core/types/agentActions/editAnnotations';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { AnnotationResultList } from '../../../components/agentRuns/toolResultViews/AnnotationListResultView';
import type { AnnotationRowView } from '../../../types/toolResultViews';
import type { ActionStatus } from './agentActionViewHelpers';

function plural(count: number): string {
    return count === 1 ? '' : 's';
}

function referenceKey(ref: ZoteroItemReference): string {
    return `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
}

/** Keep delete rows in the same order as the action's target references. */
export function deleteAnnotationSnapshots(
    refs: ZoteroItemReference[] | undefined,
    snapshots: AnnotationPreviewSnapshot[],
): AnnotationPreviewSnapshot[] {
    const byKey = new Map(
        snapshots.map((snapshot) => [referenceKey(snapshot), snapshot]),
    );
    return (refs ?? [])
        .map((ref) => byKey.get(referenceKey(ref)))
        .filter((snapshot): snapshot is AnnotationPreviewSnapshot =>
            Boolean(snapshot),
        );
}

/** Adapt the persisted action snapshot to the shared annotation-list row. */
export function deleteAnnotationRow(
    snapshot: AnnotationPreviewSnapshot,
): AnnotationRowView {
    return {
        kind: 'annotation',
        library_id: snapshot.library_id,
        zotero_key: snapshot.zotero_key,
        library_ref: snapshot.library_ref,
        annotation_type: snapshot.annotation_type,
        text: snapshot.text,
        comment: snapshot.comment,
        color: snapshot.color,
        page_label: snapshot.page_label,
        tags: snapshot.tags,
    };
}

/**
 * Approval and history preview for annotation deletion.
 *
 * Deletion has no per-target operation to explain, so the action header owns
 * the verb and this body is simply the same compact annotation list used by
 * find_annotations.
 */
export const DeleteAnnotationsPreview: React.FC<{
    actionData: Record<string, any>;
    currentValue?: { annotations?: AnnotationPreviewSnapshot[] };
    resultData?: {
        before?: AnnotationPreviewSnapshot[];
        skipped?: Array<{ annotation_id: string; reason: string }>;
    };
    status: ActionStatus | 'awaiting';
}> = ({ actionData, currentValue, resultData, status }) => {
    const snapshots: AnnotationPreviewSnapshot[] =
        resultData?.before ??
        currentValue?.annotations ??
        actionData.annotation_previews ??
        [];
    const rows = deleteAnnotationSnapshots(
        actionData.annotation_refs,
        snapshots,
    ).map(deleteAnnotationRow);
    // The result's list supersedes the proposal's: it is the same validation
    // skips plus anything execution dropped when it re-resolved the batch.
    const skipped: Array<{ annotation_id: string; reason: string }> =
        (Array.isArray(resultData?.skipped) ? resultData.skipped : null) ??
        (Array.isArray(actionData.skipped) ? actionData.skipped : []);
    const isDimmed = status === 'rejected' || status === 'undone';

    if (rows.length === 0 && skipped.length === 0) return null;

    return (
        <div className={isDimmed ? 'opacity-60' : undefined}>
            <AnnotationResultList
                annotations={rows}
                variant="compact"
                emptyMessage={null}
            />

            {skipped.length > 0 && (
                <div className="text-sm font-color-tertiary px-3 py-2">
                    {`${skipped.length} annotation${plural(skipped.length)} skipped: ${skipped[0].reason}`}
                    {skipped.length > 1 ? ` (+${skipped.length - 1} more)` : ''}
                </div>
            )}
        </div>
    );
};

export default DeleteAnnotationsPreview;
