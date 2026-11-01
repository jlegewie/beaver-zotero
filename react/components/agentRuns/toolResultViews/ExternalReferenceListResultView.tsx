import React, { useMemo, useState } from 'react';
import {
    ExternalReferenceListView,
    RelatedWorksViewInfo,
    SearchViewInfo,
    relatedWorksViewInfo,
    searchViewInfo,
} from '@beaver/agent-core/run-state/toolResultViews';
import {
    ExternalReference,
    authorLastNames,
} from '@beaver/agent-core/types/externalReferences';
import { combineSnapshotList } from '@beaver/agent-core/citations/externalRecords';
import { externalRecordPresentation, formatRegistryDate } from '@beaver/agent-core/citations/externalRecordDisplay';
import { trialDetails } from '@beaver/agent-core/types/externalReferences';
import { ArrowDownIcon, ArrowRightIcon, ArrowUpRightIcon } from '@beaver/agent-ui/icons';
import CopyButton from '../../ui/buttons/CopyButton';
import { getHost } from '@beaver/agent-ui/host';
import ExternalReferenceListItem from '../../externalReferences/ExternalReferenceListItem';
import PubMedReferenceListItem from '../../externalReferences/PubMedReferenceListItem';
import TrialReferenceListItem from '../../externalReferences/TrialReferenceListItem';

/** Compact citation-style label for a work: "Vaswani et al. (2017)". */
function workShortLabel(work: ExternalReference): string {
    const parts: string[] = [];
    const lastNames = authorLastNames(work);
    if (lastNames[0]) {
        parts.push(lastNames.length > 1 ? `${lastNames[0]} et al.` : lastNames[0]);
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

const FILTER_LABELS: Record<string, string> = {
    condition: 'Condition',
    intervention: 'Intervention',
    sponsor: 'Sponsor',
    location: 'Location',
};

const SORT_LABELS: Record<string, string> = {
    newest: 'Newest first',
    last_updated: 'Recently updated',
};

function humanize(value: string): string {
    const spaced = value.replace(/_/g, ' ').trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

function phaseLabel(value: string): string {
    const match = /^(early_)?phase(\d)$/i.exec(value);
    if (match) return `${match[1] ? 'Early ' : ''}Phase ${match[2]}`;
    return value === 'not_applicable' ? 'Phase N/A' : humanize(value);
}

function yearRange(min: unknown, max: unknown): string | null {
    const from = typeof min === 'number' ? String(min) : '';
    const to = typeof max === 'number' ? String(max) : '';
    if (!from && !to) return null;
    if (from && to) return from === to ? from : `${from}–${to}`;
    return from ? `${from} or later` : `${to} or earlier`;
}

/**
 * The filters a search ran with, as short labels. The query itself is shown
 * separately; keys this client does not know render as "key: value".
 */
export function searchFilterLabels(filters: Record<string, unknown> | null | undefined): string[] {
    if (!filters) return [];
    const labels: string[] = [];
    const handled = new Set(['query']);
    for (const [key, label] of Object.entries(FILTER_LABELS)) {
        const value = filters[key];
        handled.add(key);
        if (typeof value === 'string' && value.trim()) labels.push(`${label}: ${value.trim()}`);
    }
    const listOf = (key: string, format: (value: string) => string) => {
        handled.add(key);
        const value = filters[key];
        if (Array.isArray(value) && value.length) labels.push(value.map((entry) => format(String(entry))).join(', '));
    };
    listOf('status', humanize);
    listOf('phase', phaseLabel);
    handled.add('study_type');
    if (typeof filters.study_type === 'string') labels.push(humanize(filters.study_type));
    handled.add('has_results');
    if (filters.has_results === true) labels.push('With results');
    if (filters.has_results === false) labels.push('Without results');
    for (const [minKey, maxKey, prefix] of [
        ['start_year_min', 'start_year_max', 'Started'],
        ['min_year', 'max_year', 'Published'],
    ] as const) {
        handled.add(minKey);
        handled.add(maxKey);
        const range = yearRange(filters[minKey], filters[maxKey]);
        if (range) labels.push(`${prefix} ${range}`);
    }
    handled.add('sort');
    if (typeof filters.sort === 'string' && filters.sort !== 'relevance') {
        labels.push(SORT_LABELS[filters.sort] ?? humanize(filters.sort));
    }
    for (const [key, value] of Object.entries(filters)) {
        if (handled.has(key) || value === null || value === undefined || value === '') continue;
        labels.push(`${humanize(key)}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
    }
    return labels;
}

/** "Open in PubMed", "Open on ClinicalTrials.gov". */
function openOnSiteLabel(info: SearchViewInfo): string {
    const label = info.source_label || info.source;
    return info.source === 'pubmed' ? `Open in ${label}` : `Open on ${label}`;
}

function openUrl(url: string) {
    getHost().navigation?.openExternalUrl(url);
}

/**
 * The bar above a source search's results (pubmed_search, search_trials).
 * The tool label already names the search and the hit count, so the bar holds
 * only what the label cannot: the full search (the query as sent, its
 * filters, and for PubMed the query as PubMed ran it, with a copy button)
 * behind "Search details", and a link that runs the same search on the source's site.
 */
const SearchBar: React.FC<{ info: SearchViewInfo }> = ({ info }) => {
    const [open, setOpen] = useState(false);
    const filters = searchFilterLabels(info.filters);
    const query = typeof info.query === 'string' ? info.query.trim() : '';
    const translation = info.query_translation?.trim();
    const sourceName = info.source_label || info.source;
    const hasDetails = !!query || filters.length > 0 || !!translation;
    const searchUrl = info.search_url;
    if (!hasDetails && !searchUrl) return null;
    const Arrow = open ? ArrowDownIcon : ArrowRightIcon;

    return (
        <div className="px-3 py-15 display-flex flex-col gap-2 border-bottom-quinary">
            <div className="display-flex flex-row items-center gap-2 text-sm">
                {hasDetails && (
                    <a
                        className="text-link-muted display-flex flex-row items-center gap-05"
                        role="button"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => setOpen((value) => !value)}
                    >
                        <Arrow width={12} height={12} />
                        Search details
                    </a>
                )}
                <div className="flex-1" />
                {searchUrl && (
                    <a
                        className="text-link-muted whitespace-nowrap display-flex flex-row items-center gap-05"
                        role="link"
                        tabIndex={0}
                        onClick={(event) => {
                            event.preventDefault();
                            openUrl(searchUrl);
                        }}
                    >
                        {openOnSiteLabel(info)}
                        <ArrowUpRightIcon width={12} height={12} />
                    </a>
                )}
            </div>
            {open && (
                <div className="display-flex flex-col gap-3 pb-1">
                    {query && (
                        <div className="display-flex flex-col gap-1">
                            <div className="ext-subheading">Query</div>
                            <div className="text-sm font-color-primary select-text">{query}</div>
                        </div>
                    )}
                    {filters.length > 0 && (
                        <div className="display-flex flex-col gap-1">
                            <div className="ext-subheading">Filters</div>
                            <div className="display-flex flex-row flex-wrap gap-1">
                                {filters.map((filter) => <span key={filter} className="ext-chip">{filter}</span>)}
                            </div>
                        </div>
                    )}
                    {translation && translation !== query && (
                        <div className="display-flex flex-col gap-1">
                            <div className="display-flex flex-row items-center gap-1">
                                <span className="ext-subheading">{`As ${sourceName} ran it`}</span>
                                <CopyButton
                                    content={translation}
                                    className="scale-90"
                                    title="Copy query"
                                    ariaLabel={`Copy the query as ${sourceName} ran it`}
                                />
                            </div>
                            <div className="ext-query-translation select-text">{translation}</div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * The source's attribution under its results: the data date and source line
 * ClinicalTrials.gov's terms require, or the acknowledgment NLM asks for.
 */
const SourceNotice: React.FC<{ text: string }> = ({ text }) => (
    <div className="px-3 py-2 text-xs font-color-secondary border-top-quinary">{text}</div>
);

function searchNotice(info: SearchViewInfo): string | null {
    const date = formatRegistryDate(info.data_as_of);
    const text = [date ? `Data as of ${date}` : null, info.attribution].filter(Boolean).join(' · ');
    return text || null;
}

function registryNotice(dataAsOf: string | null | undefined): string {
    const date = formatRegistryDate(dataAsOf);
    return `${date ? `Data as of ${date} · ` : ''}Source: ClinicalTrials.gov`;
}

/**
 * Shared renderer for the {@link ExternalReferenceListView} view model
 * (external_search / lookup_work / find_related_works / find_book_chapters /
 * pubmed_search / search_trials / get_trial).
 *
 * Each row is its reference combined with the view's `extra_snapshots` of
 * the same id. Rows render per source: PubMed and ClinicalTrials.gov have
 * their own rows, every other source the generic card. A search view
 * (`tool_info.info_type === 'search'`) gets a results header; an unknown
 * `info_type` renders the plain cards. A nonempty `message` renders as an advisory line above the cards;
 * the lookup_work-only extras (`not_found_queries`, `unavailable_queries`)
 * render below the matched references.
 */
export const ExternalReferenceListResultView: React.FC<{ view: ExternalReferenceListView }> = ({
    view,
}) => {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    // A row renders its reference combined with the view's other snapshots of
    // the same id; nothing from other tools is mixed in.
    const combined = useMemo(
        () => combineSnapshotList([...(view.references ?? []), ...(view.extra_snapshots ?? [])]),
        [view.references, view.extra_snapshots],
    );
    const references = (view.references ?? []).map((reference) =>
        (reference.source_id && combined.get(reference.source_id)) || reference);
    const notFoundQueries = view.not_found_queries ?? [];
    const unavailableQueries = view.unavailable_queries ?? [];
    const relatedInfo = relatedWorksViewInfo(view);
    const searchInfo = searchViewInfo(view);
    const isLookupWork = view.tool_name === 'lookup_work' || view.tool_name === 'get_trial';

    if (references.length === 0 && notFoundQueries.length === 0 && unavailableQueries.length === 0) {
        const emptyDefault = relatedInfo
            ? relatedInfo.relation === 'references'
                ? 'No references found'
                : 'No citing works found'
            : searchInfo
              ? `No results in ${searchInfo.source_label || searchInfo.source}`
              : isLookupWork
                ? (view.tool_name === 'get_trial' ? 'No trials found' : 'No works found')
                : view.tool_name === 'find_book_chapters'
                  ? 'No chapters found'
                  : 'No external references found';
        return (
            <div className="display-flex flex-col">
                {searchInfo && <SearchBar info={searchInfo} />}
                <div className="p-3 text-sm font-color-tertiary">
                    {view.message || emptyDefault}
                </div>
                {searchInfo && searchNotice(searchInfo) && <SourceNotice text={searchNotice(searchInfo)!} />}
            </div>
        );
    }

    const inLibraryCount = references.filter((ref) => (ref.library_items?.length ?? 0) > 0).length;
    const trialRows = references.filter((ref) =>
        externalRecordPresentation(searchInfo?.source ?? ref.source, ref) === 'trial');

    return (
        <div className="display-flex flex-col">
            {/* {relatedInfo && (
                <RelatedWorksHeader
                    info={relatedInfo}
                    shownCount={references.length}
                    inLibraryCount={inLibraryCount}
                />
            )} */}

            {searchInfo && <SearchBar info={searchInfo} />}

            {/* {view.message && (
                <div className="px-3 py-2 text-sm font-color-tertiary border-b border-color-quinary">
                    {view.message}
                </div>
            )} */}

            {references.map((item, index) => {
                const rowProps = {
                    item,
                    viewSource: searchInfo?.source ?? null,
                    isHovered: hoveredIndex === index,
                    onMouseEnter: () => setHoveredIndex(index),
                    onMouseLeave: () => setHoveredIndex(null),
                };
                const key = item.source_id ?? `ref-${index}`;
                switch (externalRecordPresentation(searchInfo?.source ?? item.source, item)) {
                    case 'pubmed':
                        return <PubMedReferenceListItem key={key} {...rowProps} />;
                    case 'trial':
                        return <TrialReferenceListItem key={key} {...rowProps} />;
                    default:
                        return <ExternalReferenceListItem key={key} {...rowProps} />;
                }
            })}


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

            {searchInfo && searchNotice(searchInfo) && <SourceNotice text={searchNotice(searchInfo)!} />}
            {!searchInfo && trialRows.length > 0 && (
                <SourceNotice text={registryNotice(trialDetails(trialRows[0])?.data_as_of)} />
            )}
        </div>
    );
};

export default ExternalReferenceListResultView;
