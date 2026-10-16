import React, { useState } from 'react';
import type {
    DuplicateGroup,
    DuplicateMember,
    DuplicatesResultView as View,
} from '@beaver/agent-core/protocol/duplicates';
import { getHost } from '@beaver/agent-ui/host';
import { itemTypeToIconName } from '@beaver/agent-core/types/citations';
import { AlertIcon, ArrowRightIcon, CSSItemTypeIcon, Icon } from '../../icons/icons';
import { formatFieldName } from '../../../utils/fieldLabels';
import {
    FieldValue,
    MemberBadge,
    comparableFields,
    groupFieldValues,
    groupMemberLines,
    memberByline,
    showsBylines,
} from './duplicateDisplay';
import type { MemberLines } from './duplicateDisplay';

/**
 * Renderer for `find_duplicates` results.
 *
 * Each candidate group is one hairline-separated block: the shared title with
 * its item-type icon, then one lettered row per record (click to reveal it in
 * the library), any conflict warnings, and a collapsible field-by-field
 * comparison keyed by the same letters.
 */

function revealMember(member: DuplicateMember): void {
    getHost().navigation?.revealInLibrary({
        library_id: 0,
        library_ref: member.library_ref,
        zotero_key: member.zotero_key,
    });
}

const MemberRow: React.FC<{ member: DuplicateMember; index: number; lines: MemberLines }> = ({
    member,
    index,
    lines,
}) => {
    return (
        <div
            role="button"
            tabIndex={0}
            className="duplicate-member-row display-flex flex-row items-start gap-2 px-2 py-1 rounded-md cursor-pointer"
            title="Click to reveal in Zotero"
            onClick={() => revealMember(member)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    revealMember(member);
                }
            }}
        >
            <MemberBadge index={index} />
            <div className="display-flex flex-col min-w-0 flex-1" style={{ gap: '1px' }}>
                <div className="text-sm font-color-primary">{lines.primary}</div>
                {lines.secondary && <div className="text-sm font-color-secondary">{lines.secondary}</div>}
            </div>
        </div>
    );
};

export const DuplicateWarnings: React.FC<{ warnings: string[] }> = ({ warnings }) => (
    <>
        {warnings.map((warning) => (
            <div key={warning} role="note" className="display-flex flex-row items-start gap-2 text-sm font-color-secondary">
                <Icon icon={AlertIcon} className="font-color-orange flex-shrink-0 mt-010" />
                <span>{warning}</span>
            </div>
        ))}
    </>
);

/** One field across all records; records sharing a value share a row. */
const FieldComparison: React.FC<{ group: DuplicateGroup; field: string }> = ({ group, field }) => {
    const rows = groupFieldValues(group, field);
    return (
        <div className="display-flex flex-col gap-1">
            <div className="text-sm font-color-secondary font-medium">{formatFieldName(field)}</div>
            {rows.map((row) => (
                <div key={row.indices.join()} className="display-flex flex-row items-start gap-2 text-sm">
                    <span className="display-flex flex-row gap-05 flex-shrink-0">
                        {row.indices.map((i) => <MemberBadge key={i} index={i} />)}
                    </span>
                    <span className="min-w-0 font-color-primary">
                        <FieldValue value={row.value} />
                    </span>
                </div>
            ))}
        </div>
    );
};

const DuplicateGroupView: React.FC<{ group: DuplicateGroup }> = ({ group }) => {
    const [expanded, setExpanded] = useState(false);
    const first = group.members[0];
    const differing = comparableFields(group);
    const showByline = showsBylines(group);
    // Shared author and year describe the work, so they sit under its title.
    const sharedByline = showByline ? null : memberByline(first);
    const memberLabels = groupMemberLines(group);
    const summary = differing.map(formatFieldName).join(', ');
    return (
        <div className="display-flex flex-col gap-1 py-2 px-1">
            <div className="display-flex flex-row items-start gap-2 px-2">
                <span className="flex-shrink-0 -mt-010">
                    <CSSItemTypeIcon itemType={itemTypeToIconName(first.item_type, undefined)} className="scale-90" />
                </span>
                <div className="display-flex flex-col flex-1 min-w-0" style={{ gap: '1px' }}>
                    <div className="font-color-primary duplicate-group-title">{first.title}</div>
                    {sharedByline && <div className="text-sm font-color-secondary truncate">{sharedByline}</div>}
                </div>
                <div className="text-sm font-color-secondary flex-shrink-0" style={{ whiteSpace: 'nowrap' }}>
                    {group.members.length} records
                </div>
            </div>
            <div className="display-flex flex-col duplicate-group-body">
                {group.members.map((member, index) => (
                    <MemberRow
                        key={member.item_id}
                        member={member}
                        index={index}
                        lines={memberLabels[index]}
                    />
                ))}
            </div>
            {(group.warnings.length > 0 || differing.length > 0) && (
                <div className="display-flex flex-col gap-1 duplicate-group-body px-2">
                    {differing.length > 0 && (
                        <button
                            type="button"
                            className="duplicate-differences-toggle display-flex flex-row items-center gap-1 text-sm font-color-secondary"
                            aria-expanded={expanded}
                            onClick={() => setExpanded((v) => !v)}
                        >
                            <Icon
                                icon={ArrowRightIcon}
                                className="flex-shrink-0 scale-90"
                                style={{ transform: expanded ? 'rotate(90deg) scale(0.9)' : undefined, transition: 'transform 120ms' }}
                            />
                            <span className="truncate">
                                {differing.length === 1 ? 'Differs in ' : `${differing.length} differences: `}
                                {summary}
                            </span>
                        </button>
                    )}
                    {expanded && (
                        <div className="duplicate-differences display-flex flex-col gap-2">
                            {differing.map((field) => (
                                <FieldComparison key={field} group={group} field={field} />
                            ))}
                        </div>
                    )}
                    <DuplicateWarnings warnings={group.warnings} />
                </div>
            )}
        </div>
    );
};

export const DuplicatesResultView: React.FC<{ view: View }> = ({ view }) => {
    if (!view.groups.length) {
        return <div className="p-3 text-sm font-color-secondary">No duplicate items found</div>;
    }
    const shown = view.groups.length;
    // The view carries no offset; recover it from where the page ends.
    const start = (view.next_offset ?? view.total_count) - shown + 1;
    const end = start + shown - 1;
    return (
        <div className="display-flex flex-col min-w-0" data-testid="duplicates-result">
            {view.groups.map((group, index) => (
                <div key={group.group_id} className={index < shown - 1 ? 'border-bottom-quinary' : ''}>
                    <DuplicateGroupView group={group} />
                </div>
            ))}
            {view.total_count > shown && (
                <div className="px-3 py-2 text-sm font-color-secondary border-top-quinary">
                    Showing groups {start}–{end} of {view.total_count}
                </div>
            )}
        </div>
    );
};
