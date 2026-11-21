import React, { useState } from 'react';
import type {
    OpenAlexAuthorCandidate,
    OpenAlexNamesView,
    OpenAlexVenueCandidate,
} from '@beaver/agent-core/run-state/toolResultViews';
import { openAlexWorkUrl } from '@beaver/agent-core/citations/externalRecordDisplay';
import { openExternal } from '../../externalReferences/ExternalRecordParts';

function count(n: number | null | undefined, noun: string): string | null {
    return typeof n === 'number' ? `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}` : null;
}

function joinFacts(facts: Array<string | null | undefined>): string {
    return facts.filter((fact): fact is string => !!fact).join(' · ');
}

function venueType(type: string | null | undefined): string | null {
    if (!type) return null;
    const spaced = type.replace(/[_-]/g, ' ').trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : null;
}

/** Second and third lines of a candidate: where it is, then its record at a glance. */
function candidateLines(kind: OpenAlexNamesView['kind'], candidate: OpenAlexAuthorCandidate | OpenAlexVenueCandidate) {
    if (kind === 'author') {
        const author = candidate as OpenAlexAuthorCandidate;
        return {
            context: (author.institutions ?? []).join(' · '),
            facts: joinFacts([
                author.active_years,
                count(author.works_count, 'work'),
                count(author.cited_by_count, 'citation'),
            ]),
        };
    }
    const venue = candidate as OpenAlexVenueCandidate;
    return {
        context: joinFacts([venue.publisher, venueType(venue.type)]),
        facts: joinFacts([venue.issn_l ? `ISSN ${venue.issn_l}` : null, count(venue.works_count, 'work')]),
    };
}

const CandidateRow: React.FC<{
    kind: OpenAlexNamesView['kind'];
    candidate: OpenAlexAuthorCandidate | OpenAlexVenueCandidate;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}> = ({ kind, candidate, isHovered, onMouseEnter, onMouseLeave }) => {
    const { context, facts } = candidateLines(kind, candidate);
    const abbreviation = kind === 'venue' ? (candidate as OpenAlexVenueCandidate).abbreviation : null;
    const url = candidate.id ? openAlexWorkUrl(candidate.id) : undefined;
    return (
        <div
            className={`px-3 py-2 display-flex flex-col gap-05 min-w-0 rounded-sm transition user-select-none ${isHovered ? 'bg-quinary' : ''}`}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="truncate">
                <span
                    className={`font-color-primary ${url ? 'cursor-pointer' : ''}`}
                    title={url ? 'Open on OpenAlex' : undefined}
                    role={url ? 'link' : undefined}
                    tabIndex={url ? 0 : undefined}
                    onClick={url ? () => openExternal(url) : undefined}
                    onKeyDown={url ? (event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            openExternal(url);
                        }
                    } : undefined}
                >
                    {candidate.name}
                </span>
                {abbreviation && abbreviation !== candidate.name && (
                    <span className="font-color-tertiary">{` (${abbreviation})`}</span>
                )}
            </div>
            {context && <div className="font-color-secondary truncate">{context}</div>}
            {facts && <div className="font-color-secondary text-sm">{facts}</div>}
        </div>
    );
};

/**
 * openalex_resolve_names: the author or venue candidates OpenAlex found for
 * each name, one group per name in the order looked up, separated by a rule.
 * Candidates carry their own names (two can share one), so the groups have no
 * heading; a name without candidates is one "not found" line, as in lookup_work.
 */
export const OpenAlexNamesResultView: React.FC<{ view: OpenAlexNamesView }> = ({ view }) => {
    const [hovered, setHovered] = useState<string | null>(null);
    const results = view.results;

    return (
        <div className="display-flex flex-col">
            {results.map((result, resultIndex) => {
                const candidates = result.candidates ?? [];
                const divider = resultIndex > 0 ? 'border-top-quinary' : '';
                if (candidates.length === 0) {
                    return (
                        <div key={`name-${resultIndex}`} className={`px-3 py-2 text-sm font-color-tertiary ${divider}`}>
                            <span className="font-color-secondary">{result.query}</span>
                            <span>{result.error ? ' — lookup unavailable' : ' — not found'}</span>
                        </div>
                    );
                }
                return (
                    <div key={`name-${resultIndex}`} className={`display-flex flex-col ${divider}`}>
                        {candidates.map((candidate, index) => {
                            const key = `${resultIndex}-${candidate.id ?? index}`;
                            return (
                                <CandidateRow
                                    key={key}
                                    kind={view.kind}
                                    candidate={candidate}
                                    isHovered={hovered === key}
                                    onMouseEnter={() => setHovered(key)}
                                    onMouseLeave={() => setHovered(null)}
                                />
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
};

export default OpenAlexNamesResultView;
