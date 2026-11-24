import React from 'react';
import { webPageDetails, type ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { stripHighlightTags } from '@beaver/agent-core/identity/webPages';
import { getHost } from '@beaver/agent-ui/host';
import { GlobalSearchIcon, Icon } from '@beaver/agent-ui/icons';
import { openExternal } from './ExternalRecordParts';
import { ReferenceRowFrame } from './ExternalReferenceListItem';

interface WebPageListItemProps {
    item: ExternalReference;
    /** The page's search highlights, with their sentence tags; absent for a page that was read. */
    highlights?: string | null;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

/**
 * A web page from web search (or a page the agent read): the site and date,
 * the title linking to the page, and the excerpts the search returned. The
 * actions reveal the page in the library or import it.
 */
const WebPageListItem: React.FC<WebPageListItemProps> = ({
    item,
    highlights,
    isHovered,
    onMouseEnter,
    onMouseLeave,
}) => {
    const details = webPageDetails(item);
    const url = item.url || undefined;
    const site = details?.site_name || details?.site || null;
    const date = item.publication_date || (item.year ? String(item.year) : null);
    const excerpt = highlights ? stripHighlightTags(highlights).trim() : '';

    return (
        <ReferenceRowFrame item={item} isHovered={isHovered} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
            <div className="display-flex flex-col gap-1 min-w-0">
                <div className="display-flex flex-row items-center gap-15 min-w-0 text-sm font-color-secondary">
                    {/* A remote favicon would tell the site that its result was shown. */}
                    <Icon icon={GlobalSearchIcon} className="font-color-tertiary scale-90" />
                    <span className="truncate">{[site, date].filter(Boolean).join(' · ')}</span>
                </div>
                <div
                    className={`font-color-primary ${url ? 'cursor-pointer' : ''}`}
                    title={url}
                    onClick={url ? () => openExternal(url) : undefined}
                >
                    {item.title || url || item.source_id}
                </div>
                {excerpt && (
                    <div
                        className="font-color-secondary text-sm"
                        style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden', wordBreak: 'break-word' }}
                    >
                        {excerpt}
                    </div>
                )}
            </div>
            {getHost().components?.externalReferenceActions({
                item,
                detailsButtonMode: 'none',
                webButtonMode: 'icon-only',
                pdfButtonMode: 'none',
                webUrl: url,
                showCitationCount: false,
            })}
        </ReferenceRowFrame>
    );
};

export default WebPageListItem;
