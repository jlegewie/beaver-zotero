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
import { RecordBadge, RecordLink, RetractedBanner, openExternal } from './ExternalRecordParts';
import { ReferenceRowFrame } from './ExternalReferenceListItem';

interface PubMedReferenceListItemProps {
    item: ExternalReference;
    /** Source of the results view the row is in; selects the primary link. */
    viewSource?: string | null;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

/**
 * A PubMed result as PubMed shows it: title, authors, an NLM citation line,
 * the PMID, publication-type badges, the Free PMC article badge and a
 * Retracted banner.
 */
const PubMedReferenceListItem: React.FC<PubMedReferenceListItemProps> = ({
    item,
    viewSource,
    isHovered,
    onMouseEnter,
    onMouseLeave,
}) => {
    const pmid = recordPmid(item);
    const pmcid = item.identifiers?.pmcid;
    const primaryUrl = primaryExternalUrl(item, viewSource);
    const authors = formatAuthors(item.authors);
    const line = citationLine(item);
    const badges = publicationTypeBadges(item);
    const freePmc = isFreePmcArticle(item);

    return (
        <ReferenceRowFrame item={item} isHovered={isHovered} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
            {item.is_retracted && <RetractedBanner />}
            <div className="display-flex flex-col gap-1 min-w-0">
                <div
                    className={`font-color-primary ${primaryUrl ? 'cursor-pointer' : ''}`}
                    onClick={primaryUrl ? () => openExternal(primaryUrl) : undefined}
                >
                    {item.title || 'Untitled Item'}
                </div>
                {authors && <div className="font-color-secondary truncate">{authors}</div>}
                {line && <div className="font-color-secondary truncate"><i>{line}</i></div>}
                {(pmid || badges.length > 0 || pmcid) && (
                    <div className="display-flex flex-row flex-wrap items-center gap-1 text-sm font-color-tertiary">
                        {pmid && <span className="select-text">PMID: {pmid}</span>}
                        {badges.map((badge) => <RecordBadge key={badge} label={badge} />)}
                        {pmcid && (freePmc
                            ? <RecordLink url={pmcUrl(pmcid)}><RecordBadge label="Free PMC article" tone="green" /></RecordLink>
                            : <RecordLink url={pmcUrl(pmcid)}>PMC</RecordLink>)}
                    </div>
                )}
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
