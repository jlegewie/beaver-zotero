import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
    AnnotationBeforeSnapshot,
    AnnotationEditGroup,
    AnnotationRelocation,
    EditAnnotationsPatch,
    EditAnnotationsProposedData,
} from '@beaver/agent-core/types/agentActions/editAnnotations';
import { editAnnotationsTargets } from '@beaver/agent-core/types/agentActions/editAnnotations';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { logger } from '@beaver/agent-core/platform/logger';
import { ZoteroIcon, ZOTERO_ICONS } from '../../../components/icons/ZoteroIcon';
import { navigateToAnnotation } from '../../../utils/readerUtils';
import {
    BEAVER_ANNOTATION_COLORS,
    ZOTERO_ANNOTATION_PALETTE_COLORS,
} from '../../../../src/constants/annotations';
import { resolveItemReference } from '../../../../src/utils/libraryIdentity';
import { loadAnnotationEditData } from '../../../../src/services/agentDataProvider/actions/editAnnotations';
import { truncateText } from '../../../utils/stringUtils';
import { TagPill } from '../../../components/agentRuns/TagPill';
import {
    AnnotationTooltip,
    getAnnotationTooltipIcon,
} from '../../../components/agentRuns/AnnotationTooltip';
import type { ActionStatus } from './agentActionViewHelpers';

/** One edit and the annotations it applies to, in wire order. */
export interface EditGroupView {
    key: string;
    changes?: EditAnnotationsPatch;
    relocation?: AnnotationRelocation;
    rows: AnnotationBeforeSnapshot[];
}

const MAX_COMMENT_PREVIEW = 60;

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
    if (text) return `“${truncateText(text, 40)}”`;
    return 'a new position';
}

/** Colour swatch shown next to a colour name. */
const Swatch: React.FC<{ color: string }> = ({ color }) => (
    <span
        className="inline-block rounded-sm border-quinary shrink-0"
        style={{ width: 10, height: 10, backgroundColor: color }}
    />
);

/**
 * The edit itself, stated once above the annotations it applies to.
 *
 * A group can carry several changes at once (recolour plus retag, say), so each
 * one gets its own line rather than being packed into a sentence.
 */
const ChangeDescription: React.FC<{
    changes?: EditAnnotationsPatch;
    relocation?: AnnotationRelocation;
    isDelete: boolean;
}> = ({ changes, relocation, isDelete }) => {
    if (isDelete) return <span>Move to trash</span>;

    const lines: React.ReactNode[] = [];

    if (changes?.color != null) {
        lines.push(
            <span
                key="color"
                className="display-flex flex-row items-center gap-1 flex-wrap"
            >
                <span>Change color to</span>
                <Swatch color={ZOTERO_ANNOTATION_PALETTE_COLORS[changes.color]} />
                <span>{changes.color}</span>
            </span>,
        );
    }

    if (changes?.comment != null) {
        const comment = changes.comment.trim();
        lines.push(
            <span key="comment" style={{ overflowWrap: 'anywhere' }}>
                {comment
                    ? `Set comment to “${truncateText(comment, MAX_COMMENT_PREVIEW)}”`
                    : 'Clear comment'}
            </span>,
        );
    }

    const removeTags = changes?.remove_tags ?? [];
    if (removeTags.length) {
        lines.push(
            <span
                key="remove-tags"
                className="display-flex flex-row items-center gap-1 flex-wrap"
            >
                <span>{`Remove tag${plural(removeTags.length)}`}</span>
                {removeTags.map((tag) => (
                    <TagPill key={tag} name={tag} strike />
                ))}
            </span>,
        );
    }

    const addTags = changes?.add_tags ?? [];
    if (addTags.length) {
        lines.push(
            <span
                key="add-tags"
                className="display-flex flex-row items-center gap-1 flex-wrap"
            >
                <span>{`Add tag${plural(addTags.length)}`}</span>
                {addTags.map((tag) => (
                    <TagPill key={tag} name={tag} />
                ))}
            </span>,
        );
    }

    if (relocation) {
        lines.push(
            <span key="move">{`Move to ${relocationTarget(relocation)}`}</span>,
        );
    }

    if (!lines.length) return <span>No changes</span>;
    return <>{lines}</>;
};

/**
 * What the whole action adds up to, for a batch whose groups do different
 * things. Annotations are counted once even when several groups touch them,
 * and only changes that actually land on an annotation are named — a tag verb
 * that is a no-op for every target is not part of the net effect.
 */
export function netSummary(
    groups: EditGroupView[],
    isDelete: boolean,
): string | null {
    const touched = new Set<string>();
    const aspects: string[] = [];
    const note = (aspect: string) => {
        if (!aspects.includes(aspect)) aspects.push(aspect);
    };

    for (const group of groups) {
        for (const snapshot of group.rows) {
            touched.add(referenceKey(snapshot));
            if (isDelete) continue;
            if (group.changes?.color != null) note('recolored');
            if (group.changes?.comment != null) note('comment updated');
            const { added, removed } = annotationTagDelta(
                snapshot,
                group.changes,
            );
            if (added.length || removed.length) note('tags updated');
            if (group.relocation) note('moved');
        }
    }

    if (!touched.size) return null;
    const count = `${touched.size} annotation${plural(touched.size)}`;
    if (isDelete) return `${count} moved to trash`;
    return aspects.length ? `${count}: ${aspects.join(', ')}` : count;
}

/**
 * A pre-edit snapshot rebuilt from the annotation itself.
 *
 * Used only when the action carries none — a rejected or undone action has no
 * stored snapshots, and in both of those states the annotation is at its
 * pre-edit values anyway, so reading it back is accurate.
 */
function snapshotFromItem(
    ref: ZoteroItemReference,
    item: Zotero.Item,
): AnnotationBeforeSnapshot {
    return {
        // Spread the reference rather than rebuilding it from the item so the
        // snapshot keys exactly like the ref it was resolved from.
        ...ref,
        annotation_id: referenceKey(ref),
        color: item.annotationColor ?? '',
        comment: item.annotationComment ?? '',
        tags: item.getTags().map((tag: { tag: string }) => tag.tag),
        annotation_type: item.annotationType,
        page_label: item.annotationPageLabel ?? '',
        ...(item.annotationType === 'highlight'
            ? { text: item.annotationText ?? '' }
            : {}),
    };
}

/**
 * Approval and history card for annotation edits and deletions.
 *
 * Laid out per edit rather than per annotation: the group is what the user is
 * approving, so each one states its change once and lists the annotations it
 * lands on, with a net line when a batch does several different things.
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

    const targetRefs = useMemo(
        () =>
            editAnnotationsTargets(
                actionData as unknown as EditAnnotationsProposedData,
            ),
        [actionData],
    );

    // Snapshots come from validation while an approval is pending and from the
    // stored result afterwards, so a history card renders identically without
    // reading Zotero again. `annotation_snapshots` is where undo parks them:
    // resolving an action clears its result data.
    const storedSnapshots: AnnotationBeforeSnapshot[] =
        resultData?.before ??
        actionData.annotation_snapshots ??
        currentValue?.annotations ??
        [];

    const [recovered, setRecovered] = useState<AnnotationBeforeSnapshot[]>([]);
    const needsRecovery = storedSnapshots.length === 0 && targetRefs.length > 0;
    const targetKey = targetRefs.map(referenceKey).join('|');

    useEffect(() => {
        if (!needsRecovery) {
            setRecovered((prev) => (prev.length ? [] : prev));
            return;
        }
        let cancelled = false;
        (async () => {
            const found: AnnotationBeforeSnapshot[] = [];
            for (const ref of targetRefs) {
                try {
                    const resolved = await resolveItemReference(ref);
                    if (resolved.status !== 'found') continue;
                    if (!resolved.item.isAnnotation()) continue;
                    // Annotation fields and tags load lazily; reading them off
                    // a cold item throws.
                    await loadAnnotationEditData(resolved.item);
                    found.push(snapshotFromItem(ref, resolved.item));
                } catch (error) {
                    logger(
                        `EditAnnotationsPreview: could not read annotation ${ref.zotero_key}: ${error}`,
                        1,
                    );
                }
            }
            if (!cancelled) setRecovered(found);
        })();
        return () => {
            cancelled = true;
        };
        // Keyed on the refs' identity rather than the array, which is rebuilt
        // on every render of the parent.
    }, [needsRecovery, targetKey]);

    const groups: EditGroupView[] = useMemo(() => {
        const snapshots = storedSnapshots.length ? storedSnapshots : recovered;
        const byKey = new Map(
            snapshots.map((snapshot) => [referenceKey(snapshot), snapshot]),
        );
        const rowsFor = (refs: ZoteroItemReference[] | undefined) =>
            (refs ?? [])
                .map((ref) => byKey.get(referenceKey(ref)))
                .filter((snapshot): snapshot is AnnotationBeforeSnapshot =>
                    Boolean(snapshot),
                );

        if (isDelete) {
            return [
                { key: 'delete', rows: rowsFor(actionData.annotation_refs) },
            ];
        }
        return ((actionData.edits ?? []) as AnnotationEditGroup[]).map(
            (group, index) => ({
                key: `edit-${index}`,
                changes: group.changes,
                relocation: group.relocation,
                rows: rowsFor(group.annotation_refs),
            }),
        );
    }, [actionData, isDelete, storedSnapshots, recovered]);

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
    // A single group already states its change above its own rows; the net
    // line only earns its space once the batch does more than one thing.
    const summary = groups.length > 1 ? netSummary(groups, isDelete) : null;

    return (
        <div className="edit-annotations-preview overflow-hidden">
            <div className="display-flex flex-col px-3 py-2 gap-2">
                {groups.map((group, index) => (
                    <div
                        key={group.key}
                        className="display-flex flex-col gap-15"
                    >
                        {index > 0 && (
                            <div className="border-top-quinary my-1" />
                        )}
                        <div
                            className={`display-flex flex-col gap-1 text-sm font-color-secondary ${
                                isDimmed ? 'opacity-60' : ''
                            }`}
                        >
                            <ChangeDescription
                                changes={group.changes}
                                relocation={group.relocation}
                                isDelete={isDelete}
                            />
                        </div>

                        <div className="display-flex flex-col gap-1">
                            {group.rows.map((snapshot) => {
                                const note = isNote(snapshot);
                                const title = rowTitle(snapshot);
                                const page = pageDisplayFor(snapshot.page_label);
                                return (
                                    <AnnotationTooltip
                                        key={`${group.key}-${referenceKey(snapshot)}`}
                                        typeLabel={
                                            note
                                                ? 'Sticky Note'
                                                : 'Highlight Annotation'
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
                                            className={`edit-annotations-preview-row display-flex flex-row items-start gap-2 py-05 cursor-pointer ${
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
                                                color={
                                                    snapshot.color ||
                                                    BEAVER_ANNOTATION_COLORS.yellow
                                                }
                                                style={{ marginTop: 2 }}
                                            />
                                            <div className="display-flex flex-row min-w-0 flex-1 justify-between gap-3">
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
                                        </div>
                                    </AnnotationTooltip>
                                );
                            })}
                        </div>
                    </div>
                ))}

                {summary && (
                    <div className="border-top-quinary pt-2 text-sm font-color-tertiary">
                        {summary}
                    </div>
                )}

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
