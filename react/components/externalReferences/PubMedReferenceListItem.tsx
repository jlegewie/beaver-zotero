import React from 'react';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { getHost } from '@beaver/agent-ui/host';
import {
    citationLine,
    isFreePmcArticle,
    pmcUrl,
    primaryExternalUrl,
    publicationTypeBadges,
    recordPmid,
} from '@beaver/agent-core/citations/externalRecordDisplay';
import { formatAuthors } from './utils';
import { RecordBadge, RecordLink, RecordTags, openExternal } from './ExternalRecordParts';
import { ReferenceRowFrame } from './ExternalReferenceListItem';

interface PubMedReferenceListItemProps {
    item: ExternalReference;
    /** Source of the results view the row is in; selects the primary link. */
    viewSource?: string | null;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

/** The record's tags: Retracted, notable publication types, and free full text in PMC. */
export const PubMedTags: React.FC<{ item: ExternalReference }> = ({ item }) => {
    const pmcid = item.identifiers?.pmcid;
    return (
        <RecordTags>
            {item.is_retracted && <RecordBadge label="Retracted" tone="red" />}
            {publicationTypeBadges(item).map((badge) => <RecordBadge key={badge} label={badge} />)}
            {pmcid && isFreePmcArticle(item) && (
                <RecordLink url={pmcUrl(pmcid)}><RecordBadge label="Free PMC article" tone="green" /></RecordLink>
            )}
        </RecordTags>
    );
};

/** "N Engl J Med. 2021;384(11):989-1002. · PMID 33567185 · PMC" */
export const PubMedCitationLine: React.FC<{ item: ExternalReference; className?: string }> = ({ item, className = '' }) => {
    const line = citationLine(item);
    const pmid = recordPmid(item);
    const pmcid = item.identifiers?.pmcid;
    // An embargoed PMC copy is linked plainly; a free one carries the green tag.
    const plainPmc = pmcid && !isFreePmcArticle(item);
    if (!line && !pmid && !plainPmc) return null;
    const parts: React.ReactNode[] = [];
    if (line) parts.push(<span key="line">{line}</span>);
    if (pmid) parts.push(<span key="pmid" className="select-text">PMID {pmid}</span>);
    if (plainPmc) parts.push(<RecordLink key="pmc" url={pmcUrl(pmcid!)}>PMC</RecordLink>);
    return (
        <div className={`font-color-secondary text-sm ${className}`}>
            {parts.map((part, index) => (
                <React.Fragment key={index}>{index > 0 && ' · '}{part}</React.Fragment>
            ))}
        </div>
    );
};

/**
 * A PubMed result as PubMed lists it: title, tags, authors, and the NLM
 * citation line with the PMID.
 */
const PubMedReferenceListItem: React.FC<PubMedReferenceListItemProps> = ({
    item,
    viewSource,
    isHovered,
    onMouseEnter,
    onMouseLeave,
}) => {
    const primaryUrl = primaryExternalUrl(item, viewSource);
    const authors = formatAuthors(item.authors);

    return (
        <ReferenceRowFrame item={item} isHovered={isHovered} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
            <div className="display-flex flex-col gap-1 min-w-0">
                <div
                    className={`font-color-primary ${primaryUrl ? 'cursor-pointer' : ''}`}
                    onClick={primaryUrl ? () => openExternal(primaryUrl) : undefined}
                >
                    {item.title || 'Untitled Item'}
                </div>
                <PubMedTags item={item} />
                {authors && <div className="font-color-secondary truncate">{authors}</div>}
                <PubMedCitationLine item={item} />
            </div>
            {getHost().components?.externalReferenceActions({
                item,
                detailsButtonMode: 'icon-only',
                webButtonMode: 'icon-only',
                pdfButtonMode: 'icon-only',
                webUrl: primaryUrl,
            })}
        </ReferenceRowFrame>
    );
};

export default PubMedReferenceListItem;
