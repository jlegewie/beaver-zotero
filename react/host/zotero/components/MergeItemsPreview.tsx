import React, { useId, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import type {
    DuplicateGroup,
    DuplicateMember,
    MergeItemsChoices,
    MergeItemsProposedData,
    MergeItemsResultData,
} from '@beaver/agent-core/protocol/duplicates';
import { inFlightAgentActionIdsAtom } from '../agentActionExecution';
import { mergeItemsChoicesAtom, updateMergeItemsChoices } from '../../../atoms/mergeItemsChoices';
import { formatFieldName } from '../../../utils/fieldLabels';
import { ArrowDownIcon, Icon } from '../../../components/icons/icons';
import {
    FieldValue,
    MERGE_IGNORED_FIELDS,
    groupFieldValues,
    groupMemberLines,
} from '../../../components/agentRuns/toolResultViews/duplicateDisplay';
import type { FieldValueGroup } from '../../../components/agentRuns/toolResultViews/duplicateDisplay';
import { DuplicateWarnings } from '../../../components/agentRuns/toolResultViews/DuplicatesResultView';

/**
 * Approval preview for `merge_items`.
 *
 * The card answers two questions: which record survives, and what the merged
 * record's metadata will be. Records are chosen with plain radios; each
 * differing field shows the value the merged record will have, and clicking it
 * offers the other records' values, as in Zotero's merge pane. Which record a
 * value came from is deliberately not shown: the reader judges the result.
 */

/** Bibliographic fields first, in reading order; the rest follow by label. */
const FIELD_ORDER = [
    'title', 'creators', 'date', 'publicationTitle', 'bookTitle', 'proceedingsTitle',
    'volume', 'issue', 'pages', 'publisher', 'place', 'edition', 'DOI', 'ISBN', 'ISSN',
    'url', 'abstractNote',
];

function orderFields(fields: string[]): string[] {
    const rank = (f: string) => {
        const i = FIELD_ORDER.indexOf(f);
        return i === -1 ? FIELD_ORDER.length : i;
    };
    return [...fields].sort(
        (a, b) => rank(a) - rank(b) || formatFieldName(a).localeCompare(formatFieldName(b)),
    );
}

export type FieldOption = FieldValueGroup;

/**
 * The values offered for one field, following Zotero's merge pane: records
 * sharing a value share an option, and an empty value is never offered as an
 * alternative. The current selection and the kept record's own value are always
 * included, even when empty, so a pick can be undone.
 */
export function fieldOptions(
    group: DuplicateGroup,
    field: string,
    sourceIndex: number,
    masterIndex: number,
): FieldOption[] {
    return groupFieldValues(group, field).filter(
        (o) => o.key !== '' || o.indices.includes(sourceIndex) || o.indices.includes(masterIndex),
    );
}

/**
 * Fields the preview lists, and which of them are sourced from a record other
 * than the kept one. A field is listed when it offers a real choice under
 * Zotero's rules (no bookkeeping dates, no empty alternatives), or when its
 * value is taken from another record, since that is part of the approval.
 */
export function mergeFieldPlan(
    group: DuplicateGroup,
    masterIndex: number,
    sourceIndexFor: (field: string) => number,
): { listed: string[]; picks: string[] } {
    const fields = orderFields(group.differing_fields);
    const picks = fields.filter((f) => sourceIndexFor(f) !== masterIndex);
    const listed = fields.filter(
        (f) =>
            picks.includes(f) ||
            (!MERGE_IGNORED_FIELDS.has(f) && fieldOptions(group, f, sourceIndexFor(f), masterIndex).length > 1),
    );
    return { listed, picks };
}

/** One differing field: the merged value, expandable into the alternatives. */
const MergeField: React.FC<{
    field: string;
    value: unknown;
    options: FieldOption[] | null;
    sourceIndex: number;
    name: string;
    open: boolean;
    onToggle: () => void;
    onChoose: (option: FieldOption) => void;
}> = ({ field, value, options, sourceIndex, name, open, onToggle, onChoose }) => {
    const label = formatFieldName(field);
    const canChoose = !!options && options.length > 1;
    return (
        <div className={`merge-field${canChoose && !open ? ' merge-field-choosable' : ''}`}>
            <div className="merge-field-label" onClick={canChoose ? onToggle : undefined}>
                {label}
            </div>
            <div className="merge-field-value">
                {open && options ? (
                    <div className="display-flex flex-col gap-1" role="radiogroup" aria-label={label}>
                        {options.map((option) => (
                            <label key={option.key} className="merge-option">
                                <input
                                    type="radio"
                                    className="merge-radio"
                                    name={name}
                                    aria-label={`${label}: ${option.text ?? 'empty'}`}
                                    checked={option.indices.includes(sourceIndex)}
                                    onChange={() => onChoose(option)}
                                />
                                <span className="min-w-0">
                                    <FieldValue value={option.value} lines={4} />
                                </span>
                            </label>
                        ))}
                    </div>
                ) : canChoose ? (
                    <button type="button" className="merge-field-button" title={`Choose ${label}`} onClick={onToggle}>
                        <FieldValue value={value} lines={2} />
                    </button>
                ) : (
                    <FieldValue value={value} lines={2} />
                )}
            </div>
            {canChoose && (
                <button
                    type="button"
                    className="merge-field-toggle"
                    aria-expanded={open}
                    aria-label={open ? `Close ${label} choices` : `Choose ${label}`}
                    onClick={onToggle}
                >
                    <Icon icon={ArrowDownIcon} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
                </button>
            )}
        </div>
    );
};

export const MergeItemsPreview: React.FC<{
    actionId?: string;
    data: MergeItemsProposedData;
    result?: MergeItemsResultData;
    editable: boolean;
    compact?: boolean;
}> = ({ actionId, data, result, editable, compact = false }) => {
    const radioGroupId = useId();
    const [openField, setOpenField] = useState<string | null>(null);
    const inFlight = useAtomValue(inFlightAgentActionIdsAtom);
    const [drafts, setDrafts] = useAtom(mergeItemsChoicesAtom);
    const group = result?.preview ?? data.preview;
    if (!group)
        return <div className="p-3 text-sm font-color-secondary">Preparing merge preview…</div>;

    const choices: MergeItemsChoices =
        actionId && drafts[actionId]
            ? drafts[actionId]
            : {
                  master_item_id: data.master_item_id,
                  field_sources: data.field_sources ?? {},
                  creators_source_item_id: data.creators_source_item_id,
              };
    const masterID = result?.master_item_id ?? choices.master_item_id;
    const masterIndex = Math.max(0, group.members.findIndex((m) => m.item_id === masterID));
    const otherCount = group.members.length - 1;
    const canEdit = editable && !!actionId && !result && !inFlight.has(actionId);
    const update = (patch: Partial<MergeItemsChoices>) => {
        if (actionId)
            setDrafts((prev) => ({
                ...prev,
                [actionId]: updateMergeItemsChoices(prev[actionId], choices, patch),
            }));
    };
    const sourceIndexFor = (field: string) => {
        const sourceID =
            field === 'creators'
                ? choices.creators_source_item_id || masterID
                : choices.field_sources?.[field] || masterID;
        const index = group.members.findIndex((m) => m.item_id === sourceID);
        return index === -1 ? masterIndex : index;
    };
    const { listed, picks } = mergeFieldPlan(group, masterIndex, sourceIndexFor);
    const memberLabels = groupMemberLines(group);
    const othersPhrase = otherCount === 1 ? 'The other record' : `The other ${otherCount} records`;

    if (compact) {
        const keptName = memberLabels[masterIndex].primary.replace(/^Added/, 'added');
        return (
            <div className="px-3 py-2 display-flex flex-col gap-05 text-sm" data-testid="merge-items-summary">
                <div className="font-color-primary">
                    {result ? 'Kept' : 'Keeps'} the record {keptName}
                </div>
                <div className="font-color-secondary">
                    {othersPhrase} {result ? 'moved' : otherCount === 1 ? 'moves' : 'move'} to the Trash
                    {picks.length > 0 && ` · ${picks.map(formatFieldName).join(', ')} from another record`}
                </div>
                <DuplicateWarnings warnings={group.warnings} />
            </div>
        );
    }

    const masterAfter = result?.changes.find((c) => c.item_id === result.master_item_id)?.after;

    return (
        <div className="display-flex flex-col gap-3 p-3" data-testid="merge-items-preview">
            <section className="display-flex flex-col gap-1">
                <div className="merge-section-label">{result ? 'Kept record' : 'Record to keep'}</div>
                {group.members.map((member: DuplicateMember, index) => {
                    const kept = index === masterIndex;
                    const lines = memberLabels[index];
                    const status = kept ? (result ? 'Kept' : null) : result ? 'In Trash' : 'To Trash';
                    const body = (
                        <>
                            <div className="display-flex flex-col min-w-0 flex-1" style={{ gap: '1px' }}>
                                <div className="font-color-primary">{lines.primary}</div>
                                {lines.secondary && (
                                    <div className="text-sm font-color-secondary">{lines.secondary}</div>
                                )}
                            </div>
                            {status && (
                                <span
                                    className="text-sm font-color-secondary flex-shrink-0"
                                    style={{ whiteSpace: 'nowrap' }}
                                >
                                    {status}
                                </span>
                            )}
                        </>
                    );
                    if (result) {
                        return (
                            <div key={member.item_id} className={`merge-record${kept ? ' merge-record-kept' : ''}`}>
                                {body}
                            </div>
                        );
                    }
                    return (
                        <label
                            key={member.item_id}
                            className={`merge-record merge-record-choice${kept ? ' merge-record-kept' : ''}${
                                canEdit ? '' : ' merge-record-disabled'
                            }`}
                        >
                            <input
                                type="radio"
                                className="merge-radio"
                                name={`merge-master-${radioGroupId}`}
                                aria-label={`Keep the record ${[lines.primary, lines.secondary].filter(Boolean).join(', ')}`}
                                checked={kept}
                                disabled={!canEdit}
                                onChange={() => update({ master_item_id: member.item_id })}
                            />
                            {body}
                        </label>
                    );
                })}
                {group.warnings.length > 0 && (
                    <div className="display-flex flex-col gap-1 px-2 pt-1">
                        <DuplicateWarnings warnings={group.warnings} />
                    </div>
                )}
            </section>

            {listed.length > 0 && (
                <section className="display-flex flex-col gap-1 border-top-quinary pt-3">
                    <div className="merge-section-label">Merged metadata</div>
                    {listed.map((field) => {
                        const sourceIndex = sourceIndexFor(field);
                        return (
                            <MergeField
                                key={field}
                                field={field}
                                value={result ? masterAfter?.[field] : group.members[sourceIndex].fields[field]}
                                options={canEdit ? fieldOptions(group, field, sourceIndex, masterIndex) : null}
                                sourceIndex={sourceIndex}
                                name={`merge-field-${radioGroupId}-${field}`}
                                open={canEdit && openField === field}
                                onToggle={() => setOpenField((f) => (f === field ? null : field))}
                                onChoose={(option) => {
                                    // Prefer the kept record when it holds this value, so the
                                    // field stays on its default source.
                                    const target = option.indices.includes(masterIndex)
                                        ? masterIndex
                                        : option.indices[0];
                                    const id = group.members[target].item_id;
                                    update(
                                        field === 'creators'
                                            ? { creators_source_item_id: id }
                                            : { field_sources: { [field]: id } },
                                    );
                                    setOpenField(null);
                                }}
                            />
                        );
                    })}
                </section>
            )}

            <div className="text-sm font-color-secondary px-2">
                Notes, attachments, tags and collections from all records {result ? 'were' : 'are'} combined into the
                kept record.
            </div>
        </div>
    );
};
