import React, { useState } from 'react';
import {
    ExternalReferenceListView,
    RelatedWorksViewInfo,
} from '@beaver/agent-core/run-state/toolResultViews';
import {
    ExternalReference,
    extractAuthorLastName,
} from '@beaver/agent-core/types/externalReferences';
import ExternalReferenceListItem from '../../externalReferences/ExternalReferenceListItem';

/** Compact citation-style label for a work: "Vaswani et al. (2017)". */
function workShortLabel(work: ExternalReference): string {
    const parts: string[] = [];
    const firstAuthor = work.authors?.[0] ? extractAuthorLastName(work.authors[0]) : undefined;
    if (firstAuthor) {
        parts.push((work.authors?.length ?? 0) > 1 ? `${firstAuthor} et al.` : firstAuthor);
    }
    if (work.year) parts.push(`(${work.year})`);
    const label = parts.join(' ');
    if (label && work.title) return `${label}. ${work.title}`;
    return label || work.title || 'Unknown work';
}

/**
 * Header for find_related_works results: which work the list belongs to,
 * the direction, and how much of the full result set is shown.
 */
const RelatedWorksHeader: React.FC<{
    info: RelatedWorksViewInfo;
    shownCount: number;
    inLibraryCount: number;
}> = ({ info, shownCount, inLibraryCount }) => {
    const relationLabel = info.relation === 'references' ? 'References of' : 'Cited by';

    const countParts: string[] = [];
    if (info.total_count > shownCount) {
        countParts.push(`Showing ${shownCount} of ${info.total_count.toLocaleString()}`);
    } else if (shownCount > 0) {
        countParts.push(`${shownCount} result${shownCount === 1 ? '' : 's'}`);
    }
    if (inLibraryCount > 0) {
        countParts.push(`${inLibraryCount} in your library`);
    }

    return (
        <div className="px-3 py-2 display-flex flex-col gap-05 border-bottom-quinary">
            <div className="text-sm font-color-secondary truncate">{relationLabel} </div>
            <div className="text-base font-color-primary truncate">
                {info.work ? workShortLabel(info.work) : 'unresolved work'}
            </div>
            {countParts.length > 0 && (
                <div className="text-sm font-color-secondary">{countParts.join(' · ')}</div>
            )}
        </div>
    );
};

/**
 * Shared renderer for the {@link ExternalReferenceListView} view model
 * (external_search / lookup_work / find_related_works).
 *
 * When `tool_info` is present it renders a tool-specific header above the
 * cards (currently only the find_related_works "References of / Cited by"
 * header). A nonempty `message` renders as an advisory line above the cards;
 * the lookup_work-only extras (`not_found_queries`, `unavailable_queries`)
 * render below the matched references.
 */
export const ExternalReferenceListResultView: React.FC<{ view: ExternalReferenceListView }> = ({
    view,
}) => {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    const references = view.references;
    const notFoundQueries = view.not_found_queries ?? [];
    const unavailableQueries = view.unavailable_queries ?? [];
    const toolInfo = view.tool_info ?? null;
    const isLookupWork = view.tool_name === 'lookup_work';

    if (references.length === 0 && notFoundQueries.length === 0 && unavailableQueries.length === 0) {
        const emptyDefault = toolInfo
            ? toolInfo.relation === 'references'
                ? 'No references found'
                : 'No citing works found'
            : isLookupWork
              ? 'No works found'
              : 'No external references found';
        return (
            <div className="p-3 text-sm font-color-tertiary">
                {view.message || emptyDefault}
            </div>
        );
    }

    const inLibraryCount = references.filter((ref) => ref.library_items.length > 0).length;

    return (
        <div className="display-flex flex-col">
            {/* {toolInfo?.info_type === 'related_works' && (
                <RelatedWorksHeader
                    info={toolInfo}
                    shownCount={references.length}
                    inLibraryCount={inLibraryCount}
                />
            )} */}

            {/* {view.message && (
                <div className="px-3 py-2 text-sm font-color-tertiary border-b border-color-quinary">
                    {view.message}
                </div>
            )} */}

            {references.map((item, index) => (
                <ExternalReferenceListItem
                    key={item.source_id ?? `ref-${index}`}
                    item={item}
                    isHovered={hoveredIndex === index}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                />
            ))}

            {notFoundQueries.map((query, index) => (
                <div
                    key={`not-found-${index}`}
                    className="px-3 py-2 text-sm font-color-tertiary border-t border-color-quinary"
                >
                    <span className="font-color-secondary">{query}</span>
                    <span> — not found</span>
                </div>
            ))}

            {unavailableQueries.map((query, index) => (
                <div
                    key={`unchecked-${index}`}
                    className="px-3 py-2 text-sm font-color-tertiary border-t border-color-quinary"
                >
                    <span className="font-color-secondary">{query}</span>
                    <span> — lookup unavailable</span>
                </div>
            ))}
        </div>
    );
};

export default ExternalReferenceListResultView;
