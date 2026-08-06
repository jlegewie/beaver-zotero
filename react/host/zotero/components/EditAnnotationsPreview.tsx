import React, { useCallback } from 'react';
import type {
    AnnotationBeforeSnapshot,
    AnnotationEditGroup,
    AnnotationRelocation,
    EditAnnotationsPatch,
} from '@beaver/agent-core/types/agentActions/editAnnotations';
import { logger } from '@beaver/agent-core/platform/logger';
import { ZoteroIcon, ZOTERO_ICONS } from '../../../components/icons/ZoteroIcon';
import { ArrowRightIcon, Icon } from '../../../components/icons/icons';
import { navigateToAnnotation } from '../../../utils/readerUtils';
import {
    BEAVER_ANNOTATION_COLORS,
    ZOTERO_ANNOTATION_PALETTE_COLORS,
} from '../../../../src/constants/annotations';
import { resolveItemReference } from '../../../../src/utils/libraryIdentity';
import { TagPill } from '../../../components/agentRuns/TagPill';
import {
    AnnotationTooltip,
    getAnnotationTooltipIcon,
} from '../../../components/agentRuns/AnnotationTooltip';
import type { ActionStatus } from './agentActionViewHelpers';

/** One annotation row: its own before-state plus the change it receives. */
interface AnnotationRow {
    snapshot: AnnotationBeforeSnapshot;
    changes?: EditAnnotationsPatch;
    relocation?: AnnotationRelocation;
}

function plural(count: number): string {
    return count === 1 ? '' : 's';
}

function isNote(snapshot: AnnotationBeforeSnapshot): boolean {
    return snapshot.annotation_type === 'note';
}

function snapshotComment(snapshot: AnnotationBeforeSnapshot): string {
    return typeof snapshot.comment === 'string' ? snapshot.comment : '';
}

function snapshotTags(snapshot: AnnotationBeforeSnapshot): string[] {
    return Array.isArray(snapshot.tags)
        ? snapshot.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
}

export function annotationTagDelta(
    snapshot: AnnotationBeforeSnapshot,
    changes: EditAnnotationsPatch | undefined,
): { added: string[]; removed: string[] } {
    const existing = snapshotTags(snapshot);
    return {
        removed: (changes?.remove_tags ?? []).filter((tag) =>
            existing.includes(tag),
        ),
        added: (changes?.add_tags ?? []).filter(
            (tag) => !existing.includes(tag),
        ),
    };
}

/**
 * What the row shows as its title: a highlight is identified by the text it
 * covers, a sticky note by what it says.
 */
function rowTitle(snapshot: AnnotationBeforeSnapshot): string {
    const comment = snapshotComment(snapshot);
    const text = isNote(snapshot) ? comment : snapshot.text;
    return (typeof text === 'string' ? text : comment).trim();
}

function pageDisplayFor(value: string | null | undefined): string | null {
    const label = typeof value === 'string' ? value.trim() : '';
    return label || null;
}

function referenceKey(ref: {
    library_id: number;
    library_ref?: string;
    zotero_key: string;
}): string {
    return `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
}

/**
 * Where a move puts the annotation, in the user's terms.
 *
 * The locator the model wrote is an internal token and never shown; the
 * destination arrives already resolved, so a page label (or the text at the
 * destination, for EPUB and snapshots) is what identifies it.
 */
function relocationTarget(relocation: AnnotationRelocation): string {
    const page = pageDisplayFor(relocation.page_label);
    if (page) return `page ${page}`;
    const text = (relocation.text ?? '').trim();
    if (text) return `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;
    return 'a new position';
}

/** Colour swatch shown before/after a recolour. */
const Swatch: React.FC<{ color: string }> = ({ color }) => (
    <span
        className="inline-block rounded-sm border-quinary shrink-0"
        style={{ width: 10, height: 10, backgroundColor: color }}
    />
);

/**
 * The change one annotation receives, rendered as compact chips rather than
 * prose so a heterogeneous batch stays scannable.
 */
const ChangeSummary: React.FC<{
    row: AnnotationRow;
    isDelete: boolean;
}> = ({ row, isDelete }) => {
    const { snapshot, changes, relocation } = row;

    if (isDelete) {
        return (
            <span className="font-color-tertiary text-sm">Move to trash</span>
        );
    }

    const parts: React.ReactNode[] = [];
    const existingComment = snapshotComment(snapshot);

    if (changes?.color != null) {
        const next = ZOTERO_ANNOTATION_PALETTE_COLORS[changes.color];
        parts.push(
            <span
                key="color"
                className="display-flex flex-row items-center gap-1 font-color-tertiary text-sm"
            >
                <Swatch color={snapshot.color || BEAVER_ANNOTATION_COLORS.yellow} />
                <Icon icon={ArrowRightIcon} size={10} />
                <Swatch color={next} />
                {changes.color}
            </span>,
        );
    }

    if (changes?.comment != null) {
        parts.push(
            <span key="comment" className="font-color-tertiary text-sm truncate">
                {changes.comment.trim() === ''
                    ? 'Clear comment'
                    : existingComment.trim()
                      ? `Replace comment: ${changes.comment}`
                      : `Add comment: ${changes.comment}`}
            </span>,
        );
    }

    const { added, removed } = annotationTagDelta(snapshot, changes);
    if (added.length || removed.length) {
        parts.push(
            <span
                key="tags"
                className="display-flex flex-row items-center gap-1 flex-wrap"
            >
                {removed.map((tag) => (
                    <TagPill key={`-${tag}`} name={tag} strike />
                ))}
                {added.map((tag) => (
                    <TagPill key={`+${tag}`} name={tag} />
                ))}
            </span>,
        );
    }

    if (relocation) {
        parts.push(
            <span key="move" className="font-color-tertiary text-sm">
                {`Move to ${relocationTarget(relocation)}`}
            </span>,
        );
    }

    if (!parts.length) return null;
    return (
        <span className="display-flex flex-col gap-1 min-w-0">{parts}</span>
    );
};

/**
 * Approval and history card for annotation edits and deletions.
 *
 * Renders one row per annotation rather than one per edit group: the group is
 * an efficiency of the wire format, but the user is approving changes to
 * individual annotations and needs to see each one.
 */
export const EditAnnotationsPreview: React.FC<{
    actionData: Record<string, any>;
    currentValue?: { annotations?: AnnotationBeforeSnapshot[] };
    resultData?: { before?: AnnotationBeforeSnapshot[] };
    status: ActionStatus | 'awaiting';
}> = ({ actionData, currentValue, resultData, status }) => {
    const isDelete = (actionData.operation ?? 'edit') === 'delete';
    const skipped: Array<{ annotation_id: string; reason: string }> =
        Array.isArray(actionData.skipped) ? actionData.skipped : [];

    // Snapshots come from validation while an approval is pending and from the
    // stored result afterwards, so a history card renders identically without
    // reading Zotero again.
    const snapshots: AnnotationBeforeSnapshot[] =
        resultData?.before ?? currentValue?.annotations ?? [];
    const byId = new Map(
        snapshots.map((snapshot) => [referenceKey(snapshot), snapshot]),
    );

    const rows: AnnotationRow[] = [];
    if (isDelete) {
        for (const ref of actionData.annotation_refs ?? []) {
            const snapshot = byId.get(referenceKey(ref));
            if (snapshot) rows.push({ snapshot });
        }
    } else {
        for (const group of (actionData.edits ?? []) as AnnotationEditGroup[]) {
            for (const ref of group.annotation_refs ?? []) {
                const snapshot = byId.get(referenceKey(ref));
                if (snapshot)
                    rows.push({
                        snapshot,
                        changes: group.changes,
                        relocation: group.relocation,
                    });
            }
        }
    }

    const handleClick = useCallback(
        async (snapshot: AnnotationBeforeSnapshot) => {
            try {
                const resolved = await resolveItemReference(snapshot);
                if (resolved.status === 'found')
                    await navigateToAnnotation(resolved.item);
            } catch (error) {
                logger(`EditAnnotationsPreview: navigation failed: ${error}`, 1);
            }
        },
        [],
    );

    const isDimmed = status === 'rejected' || status === 'undone';
    const verb = isDelete ? 'Delete' : 'Edit';

    return (
        <div className="edit-annotations-preview overflow-hidden">
            <div className="display-flex flex-col px-3 py-2 gap-2">
                <div className="text-sm font-color-secondary">
                    {`${verb} ${rows.length} annotation${plural(rows.length)}`}
                </div>

                <div className="display-flex flex-col gap-1">
                    {rows.map(({ snapshot, changes, relocation }) => {
                        const note = isNote(snapshot);
                        const title = rowTitle(snapshot);
                        const page = pageDisplayFor(snapshot.page_label);
                        // The swatch previews the colour the annotation ends up
                        // with, so the row reads as the outcome being approved.
                        const color =
                            changes?.color != null
                                ? ZOTERO_ANNOTATION_PALETTE_COLORS[changes.color]
                                : snapshot.color ||
                                  BEAVER_ANNOTATION_COLORS.yellow;

                        return (
                            <AnnotationTooltip
                                key={snapshot.annotation_id}
                                typeLabel={
                                    note ? 'Sticky Note' : 'Highlight Annotation'
                                }
                                pageDisplay={page}
                                body={title}
                                footerLabel="Click to view in Zotero Reader"
                                typeIcon={getAnnotationTooltipIcon(
                                    note ? 'note' : 'highlight',
                                )}
                                stayOpenOnAnchorClick
                            >
                                <div
                                    className={`edit-annotations-preview-row display-flex flex-row items-start gap-2 py-15 cursor-pointer ${
                                        isDimmed ? 'opacity-60' : ''
                                    }`}
                                    onClick={() => handleClick(snapshot)}
                                >
                                    <ZoteroIcon
                                        icon={
                                            note
                                                ? ZOTERO_ICONS.ANNOTATION
                                                : ZOTERO_ICONS.ANNOTATE_HIGHLIGHT
                                        }
                                        size={14}
                                        color={color}
                                        style={{ marginTop: 2 }}
                                    />
                                    <div className="display-flex flex-col min-w-0 flex-1 gap-1">
                                        <div className="display-flex flex-row min-w-0 justify-between gap-3">
                                            <div
                                                className="truncate"
                                                style={
                                                    isDelete
                                                        ? {
                                                              textDecoration:
                                                                  'line-through',
                                                          }
                                                        : undefined
                                                }
                                            >
                                                {title ||
                                                    (note
                                                        ? 'Sticky note'
                                                        : 'Highlight')}
                                            </div>
                                            {page && (
                                                <div className="font-color-tertiary whitespace-nowrap">
                                                    {`Page ${page}`}
                                                </div>
                                            )}
                                        </div>
                                        <ChangeSummary
                                            row={{ snapshot, changes, relocation }}
                                            isDelete={isDelete}
                                        />
                                    </div>
                                </div>
                            </AnnotationTooltip>
                        );
                    })}
                </div>

                {skipped.length > 0 && (
                    <div className="text-sm font-color-tertiary">
                        {`${skipped.length} annotation${plural(skipped.length)} skipped: ${skipped[0].reason}`}
                        {skipped.length > 1 ? ` (+${skipped.length - 1} more)` : ''}
                    </div>
                )}
            </div>
        </div>
    );
};

export default EditAnnotationsPreview;
