import React, { useCallback, useMemo } from 'react';
import type {
    AnnotationEditGroup,
    AnnotationPreviewSnapshot,
    AnnotationRelocation,
    EditAnnotationsPatch,
} from '@beaver/agent-core/types/agentActions/editAnnotations';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { logger } from '@beaver/agent-core/platform/logger';
import { ZoteroIcon, ZOTERO_ICONS } from '../../../components/icons/ZoteroIcon';
import { navigateToAnnotation } from '../../../utils/readerUtils';
import {
    BEAVER_ANNOTATION_COLORS,
    ZOTERO_ANNOTATION_PALETTE_COLORS,
} from '../../../../src/constants/annotations';
import { resolveItemReference } from '../../../../src/utils/libraryIdentity';
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
    rows: AnnotationPreviewSnapshot[];
}

const MAX_COMMENT_PREVIEW = 60;
/** Short enough that a move chip stays one compact pill. */
const MAX_RELOCATION_CHIP = 24;

function plural(count: number): string {
    return count === 1 ? '' : 's';
}

function isNote(snapshot: AnnotationPreviewSnapshot): boolean {
    return snapshot.annotation_type === 'note';
}

function snapshotComment(snapshot: AnnotationPreviewSnapshot): string {
    return typeof snapshot.comment === 'string' ? snapshot.comment : '';
}

function snapshotTags(snapshot: AnnotationPreviewSnapshot): string[] {
    return Array.isArray(snapshot.tags)
        ? snapshot.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
}

export function annotationTagDelta(
    snapshot: AnnotationPreviewSnapshot,
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
function rowTitle(snapshot: AnnotationPreviewSnapshot): string {
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
 * Destination page label for a move, matching prepareRelocation's preference:
 * PDF highlight extent first, then the top-level relocation label.
 */
function relocationPageLabel(
    relocation: AnnotationRelocation,
): string | null {
    return pageDisplayFor(
        relocation.page_locations?.[0]?.page_label ?? relocation.page_label,
    );
}

/**
 * Where a move puts the annotation, for the compact change chip.
 *
 * Prefer a heavily truncated destination quote — page alone is a weak signal
 * for same-page sentence moves. Fall back to the page label, then a generic
 * phrase, when the destination has no text (sticky notes).
 */
function relocationTarget(relocation: AnnotationRelocation): string {
    const text = (relocation.text ?? '').trim();
    if (text) return `“${truncateText(text, MAX_RELOCATION_CHIP)}”`;
    const page = relocationPageLabel(relocation);
    if (page) return `page ${page}`;
    return 'a new position';
}

/**
 * What the row and hover show for one annotation in a group.
 *
 * A relocating highlight shows the destination text and page — that is what
 * Apply will land — rather than the pre-move snapshot. When the destination
 * has no page label, omit the page rather than inheriting the source's.
 */
function rowDisplay(
    snapshot: AnnotationPreviewSnapshot,
    relocation: AnnotationRelocation | undefined,
): { title: string; page: string | null } {
    const note = isNote(snapshot);
    const destText = (relocation?.text ?? '').trim();
    const title =
        !note && destText ? destText : rowTitle(snapshot);
    const page = relocation
        ? relocationPageLabel(relocation)
        : pageDisplayFor(snapshot.page_label);
    return { title, page };
}

/** Colour swatch shown next to a colour name. */
const Swatch: React.FC<{ color: string }> = ({ color }) => (
    <span
        className="inline-block rounded-sm border-quinary shrink-0"
        style={{ width: 10, height: 10, backgroundColor: color }}
    />
);

const CHANGE_CHIP_CLASS =
    'inline-flex items-center gap-1 text-xs px-2 py-05 rounded-md bg-quaternary font-color-secondary border-quinary';

/** Compact change label shown above the annotations it applies to. */
const ChangeChip: React.FC<{
    children: React.ReactNode;
    style?: React.CSSProperties;
}> = ({ children, style }) => (
    <span className={CHANGE_CHIP_CLASS} style={style}>
        {children}
    </span>
);

/**
 * The edit itself, stated once above the annotations it applies to.
 *
 * A group can carry several changes at once (recolour plus retag, say), so each
 * one is a compact chip rather than a full-width line.
 */
const ChangeDescription: React.FC<{
    changes?: EditAnnotationsPatch;
    relocation?: AnnotationRelocation;
}> = ({ changes, relocation }) => {
    const chips: React.ReactNode[] = [];

    if (changes?.color != null) {
        chips.push(
            <ChangeChip key="color">
                <span>Color →</span>
                <Swatch color={ZOTERO_ANNOTATION_PALETTE_COLORS[changes.color]} />
                <span>{changes.color}</span>
            </ChangeChip>,
        );
    }

    if (changes?.comment != null) {
        const comment = changes.comment.trim();
        chips.push(
            <ChangeChip
                key="comment"
                style={{ overflowWrap: 'anywhere' }}
            >
                {comment
                    ? `Comment → “${truncateText(comment, MAX_COMMENT_PREVIEW)}”`
                    : 'Comment cleared'}
            </ChangeChip>,
        );
    }

    const removeTags = changes?.remove_tags ?? [];
    for (const tag of removeTags) {
        chips.push(<TagPill key={`remove-${tag}`} name={tag} strike />);
    }

    const addTags = changes?.add_tags ?? [];
    for (const tag of addTags) {
        chips.push(<TagPill key={`add-${tag}`} name={tag} />);
    }

    if (relocation) {
        chips.push(
            <ChangeChip key="move">{`Move → ${relocationTarget(relocation)}`}</ChangeChip>,
        );
    }

    if (!chips.length) return <ChangeChip>No changes</ChangeChip>;
    return (
        <div className="display-flex flex-row flex-wrap gap-1">
            {chips}
        </div>
    );
};

/**
 * What the whole action adds up to, for a batch whose groups do different
 * things. Annotations are counted once even when several groups touch them,
 * and only changes that actually land on an annotation are named — a tag verb
 * that is a no-op for every target is not part of the net effect.
 */
export function netSummary(
    groups: EditGroupView[],
): string | null {
    const touched = new Set<string>();
    const aspects: string[] = [];
    const note = (aspect: string) => {
        if (!aspects.includes(aspect)) aspects.push(aspect);
    };

    for (const group of groups) {
        for (const snapshot of group.rows) {
            touched.add(referenceKey(snapshot));
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
    return aspects.length ? `${count}: ${aspects.join(', ')}` : count;
}

/**
 * Approval and history card for annotation edits.
 *
 * Laid out per edit rather than per annotation: the group is what the user is
 * approving, so each one states its change once and lists the annotations it
 * lands on, with a net line when a batch does several different things.
 */
export const EditAnnotationsPreview: React.FC<{
    actionData: Record<string, any>;
    currentValue?: { annotations?: AnnotationPreviewSnapshot[] };
    resultData?: { before?: AnnotationPreviewSnapshot[] };
    status: ActionStatus | 'awaiting';
}> = ({ actionData, currentValue, resultData, status }) => {
    const skipped: Array<{ annotation_id: string; reason: string }> =
        Array.isArray(actionData.skipped) ? actionData.skipped : [];

    // Where the annotations' pre-change state comes from, in order of how
    // closely it matches what ran: the execution result, the validation pass
    // behind the open approval, and the previews validation persisted on the
    // proposal — the last of which is all a rejected or undone card has, since
    // resolving an action clears its result data. Nothing is read back from
    // Zotero at render time, so a history card keeps showing the state the
    // action was taken against however the annotation is edited later.
    const snapshots: AnnotationPreviewSnapshot[] =
        resultData?.before ??
        currentValue?.annotations ??
        actionData.annotation_previews ??
        [];

    const groups: EditGroupView[] = useMemo(() => {
        const byKey = new Map(
            snapshots.map((snapshot) => [referenceKey(snapshot), snapshot]),
        );
        const rowsFor = (refs: ZoteroItemReference[] | undefined) =>
            (refs ?? [])
                .map((ref) => byKey.get(referenceKey(ref)))
                .filter((snapshot): snapshot is AnnotationPreviewSnapshot =>
                    Boolean(snapshot),
                );

        return ((actionData.edits ?? []) as AnnotationEditGroup[]).map(
            (group, index) => ({
                key: `edit-${index}`,
                changes: group.changes,
                relocation: group.relocation,
                rows: rowsFor(group.annotation_refs),
            }),
        );
    }, [actionData, snapshots]);

    const handleClick = useCallback(
        async (snapshot: AnnotationPreviewSnapshot) => {
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
    return (
        <div className="edit-annotations-preview overflow-hidden">
            <div className="display-flex flex-col px-3 py-2 gap-25">
                {groups.map((group) => (
                    <div
                        key={group.key}
                        className="display-flex flex-col gap-1"
                    >
                        <ChangeDescription
                            changes={group.changes}
                            relocation={group.relocation}
                        />

                        {group.rows.length > 0 && (
                            <div className="edit-annotations-preview-list rounded-md border-quinary overflow-hidden">
                                {group.rows.map((snapshot, rowIndex) => {
                                    const note = isNote(snapshot);
                                    const { title, page } = rowDisplay(
                                        snapshot,
                                        group.relocation,
                                    );
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
                                                className={`edit-annotations-preview-row display-flex flex-row items-center gap-2 px-25 py-2 cursor-pointer ${
                                                    rowIndex > 0
                                                        ? 'border-top-quinary'
                                                        : ''
                                                } ${isDimmed ? 'opacity-60' : ''}`}
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
                                                />
                                                <div className="display-flex flex-row min-w-0 flex-1 justify-between gap-3">
                                                    <div className="truncate">
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
                        )}
                    </div>
                ))}

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
