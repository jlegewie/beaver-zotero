import React, { useMemo, useState } from 'react';
import {
    ExternalReferenceListView,
    RelatedWorksViewInfo,
    SearchViewInfo,
    openAlexFilterName,
    relatedWorksViewInfo,
    searchSiteLabel,
    searchViewInfo,
} from '@beaver/agent-core/run-state/toolResultViews';
import { ArrowUpRightIcon } from '@beaver/agent-ui/icons';
import { RecordFacts, RecordLink } from '../../externalReferences/ExternalRecordParts';
import {
    ExternalReference,
    authorLastNames,
} from '@beaver/agent-core/types/externalReferences';
import { combineSnapshotList } from '@beaver/agent-core/citations/externalRecords';
import { externalRecordPresentation, formatRegistryDate } from '@beaver/agent-core/citations/externalRecordDisplay';
import { trialDetails } from '@beaver/agent-core/types/externalReferences';
import CopyButton from '../../ui/buttons/CopyButton';
import type { SearchDetailsDisclosure } from '../ToolResultView';
import ExternalReferenceListItem from '../../externalReferences/ExternalReferenceListItem';
import PubMedReferenceListItem from '../../externalReferences/PubMedReferenceListItem';
import TrialReferenceListItem from '../../externalReferences/TrialReferenceListItem';
import WebPageListItem from '../../externalReferences/WebPageListItem';

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
    const spaced = value.replace(/[_-]/g, ' ').trim();
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

/** A search fact: a label and its value, e.g. ["Published", "2010–2020"]. */
type SearchFact = [string, string];

/**
 * The filters and order a search ran with, as labelled facts. The query is
 * shown separately; keys this client does not know show as "Key: value".
 */
export function searchFilterFacts(filters: Record<string, unknown> | null | undefined): SearchFact[] {
    if (!filters) return [];
    const facts: SearchFact[] = [];
    const handled = new Set(['query']);
    const add = (label: string, value: string | null | undefined) => {
        if (value && value.trim()) facts.push([label, value.trim()]);
    };
    const list = (key: string, format: (value: string) => string = humanize): string | null => {
        handled.add(key);
        const value = filters[key];
        return Array.isArray(value) && value.length ? value.map((entry) => format(String(entry))).join(', ') : null;
    };
    for (const [key, label] of Object.entries(FILTER_LABELS)) {
        handled.add(key);
        add(label, typeof filters[key] === 'string' ? filters[key] as string : null);
    }
    // OpenAlex names the author and venue ids: "Katrin Wisniewski (A5012345678)".
    const entityName = (value: string) => openAlexFilterName(value) ?? value;
    const authors = list('authors', entityName);
    add(Array.isArray(filters.authors) && filters.authors.length > 1 ? 'Authors' : 'Author', authors);
    const venues = list('venues', entityName);
    add(Array.isArray(filters.venues) && filters.venues.length > 1 ? 'Journals' : 'Journal', venues);
    add('Type', list('work_types'));
    handled.add('language');
    add('Language', typeof filters.language === 'string' ? filters.language.toUpperCase() : null);
    handled.add('open_access_only');
    add('Access', filters.open_access_only === true ? 'Open access only' : null);
    add('Status', list('status'));
    add('Phase', list('phase', phaseLabel));
    add('Ages', list('age_group'));
    handled.add('study_type');
    add('Study type', typeof filters.study_type === 'string' ? humanize(filters.study_type) : null);
    for (const [key, label, noun] of [
        ['has_results', 'Results', 'posted results'],
        ['has_publications', 'Publications', 'publications'],
    ] as const) {
        handled.add(key);
        if (typeof filters[key] === 'boolean') add(label, `${filters[key] ? 'With' : 'Without'} ${noun}`);
    }
    for (const [minKey, maxKey, label] of [
        ['start_year_min', 'start_year_max', 'Started'],
        ['min_start_year', 'max_start_year', 'Started'],
        ['min_year', 'max_year', 'Published'],
    ] as const) {
        handled.add(minKey);
        handled.add(maxKey);
        add(label, yearRange(filters[minKey], filters[maxKey]));
    }
    // The order of the rows: the backend's description ("Most cited first"),
    // or an older search's sort key.
    handled.add('ranking');
    handled.add('sort');
    const ranking = typeof filters.ranking === 'string' ? filters.ranking.trim() : null;
    const sort = typeof filters.sort === 'string' && filters.sort !== 'relevance'
        ? SORT_LABELS[filters.sort] ?? humanize(filters.sort)
        : null;
    add('Order', ranking || sort);
    for (const [key, value] of Object.entries(filters)) {
        if (handled.has(key) || value === null || value === undefined || value === '') continue;
        add(humanize(key), Array.isArray(value) ? value.join(', ') : String(value));
    }
    return facts;
}

/**
 * The search a source search ran (OpenAlex, PubMed, trials): the query as
 * sent, its filters, for PubMed the query PubMed actually searched, which can be
 * copied, and a link that runs the same search on the source's site. Opened from the card header's search-details button, it sits on the
 * header's band so it reads as part of the header. Fields without content are
 * left out.
 */
const SearchDetailsPanel: React.FC<{ info: SearchViewInfo; id: string }> = ({ info, id }) => {
    const query = typeof info.query === 'string' ? info.query.trim() : '';
    const translation = info.query_translation?.trim();
    const sourceName = info.source_label || info.source;
    const showTranslation = !!translation && translation !== query;
    const facts: SearchFact[] = query ? [['Query', query], ...searchFilterFacts(info.filters)] : searchFilterFacts(info.filters);

    return (
        <div
            id={id}
            role="region"
            aria-label="Search details"
            className="bg-senary border-bottom-quinary px-3 pt-2 pb-25 display-flex flex-col gap-2 select-text"
        >
            <RecordFacts facts={facts} />
            {showTranslation && (
                <div className="display-flex flex-col gap-05">
                    <div className="display-flex flex-row items-center">
                        <span className="text-sm font-color-secondary">{`${sourceName} query`}</span>
                        <div className="flex-1" />
                        <CopyButton
                            content={translation!}
                            className="scale-90"
                            title="Copy query"
                            ariaLabel={`Copy the ${sourceName} query`}
                        />
                    </div>
                    <div className="ext-query-translation select-text" tabIndex={0}>{translation}</div>
                </div>
            )}
            {info.search_url && (
                <div className="text-sm mt-1">
                    <RecordLink url={info.search_url} className="inline-flex items-center gap-05">
                        {searchSiteLabel(info)}
                        <ArrowUpRightIcon width={12} height={12} color="currentColor" />
                    </RecordLink>
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
    if (!info.attribution) return null;
    const date = formatRegistryDate(info.data_as_of);
    return `${info.attribution} ${date ? `(${date})` : ''}`;
}

function registryNotice(dataAsOf: string | null | undefined): string {
    const date = formatRegistryDate(dataAsOf);
    return `Source: ClinicalTrials.gov ${date ? `(${date})` : ''}`;
}

/**
 * Shared renderer for the {@link ExternalReferenceListView} view model
 * (external_search / lookup_work / find_related_works / find_book_chapters /
 * pubmed_search / search_trials / get_trial).
 *
 * Each row is its reference combined with the view's `extra_snapshots` of
 * the same id. Rows render per source: PubMed and ClinicalTrials.gov have
 * their own rows, every other source the generic card. get_trial lists the
 * requested trials first, then their publications under a subheading. A search view
 * (`tool_info.info_type === 'search'`) gets a results header; an unknown
 * `info_type` renders the plain cards. A nonempty `message` renders as an advisory line above the cards;
 * the lookup_work-only extras (`not_found_queries`, `unavailable_queries`)
 * render below the matched references.
 */
export const ExternalReferenceListResultView: React.FC<{
    view: ExternalReferenceListView;
    /** The search-details panel, opened from the card header. */
    searchDetails?: SearchDetailsDisclosure;
}> = ({ view, searchDetails }) => {
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
                {searchInfo && searchDetails?.open && <SearchDetailsPanel info={searchInfo} id={searchDetails.id} />}
                <div className="p-3 text-sm font-color-tertiary">
                    {view.message || emptyDefault}
                </div>
                {searchInfo && searchNotice(searchInfo) && <SourceNotice text={searchNotice(searchInfo)!} />}
            </div>
        );
    }

    const inLibraryCount = references.filter((ref) => (ref.library_items?.length ?? 0) > 0).length;
    const presentations = references.map((ref) => externalRecordPresentation(searchInfo?.source ?? ref.source, ref));
    const trialRows = references.filter((_, index) => presentations[index] === 'trial');
    // get_trial follows the trials with their publications.
    const publicationsStart = view.tool_name === 'get_trial'
        ? presentations.findIndex((presentation) => presentation !== 'trial')
        : -1;

    return (
        <div className="display-flex flex-col">
            {/* {relatedInfo && (
                <RelatedWorksHeader
                    info={relatedInfo}
                    shownCount={references.length}
                    inLibraryCount={inLibraryCount}
                />
            )} */}

            {searchInfo && searchDetails?.open && <SearchDetailsPanel info={searchInfo} id={searchDetails.id} />}

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
                let row: React.ReactNode;
                switch (presentations[index]) {
                    case 'pubmed':
                        row = <PubMedReferenceListItem {...rowProps} />;
                        break;
                    case 'trial':
                        row = <TrialReferenceListItem {...rowProps} />;
                        break;
                    case 'webpage':
                        // Hairlines between pages, as between items in a library list.
                        row = (
                            <div className={index < references.length - 1 ? 'border-bottom-quinary' : ''}>
                                <WebPageListItem {...rowProps} siteIcon={item.source_id ? view.site_icons?.[item.source_id] : null} />
                            </div>
                        );
                        break;
                    default:
                        row = <ExternalReferenceListItem {...rowProps} />;
                }
                return (
                    <React.Fragment key={key}>
                        {index === publicationsStart && (
                            <div className="px-3 pt-3 pb-1 text-sm font-color-secondary border-top-quinary">Publications</div>
                        )}
                        {row}
                    </React.Fragment>
                );
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
