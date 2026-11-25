import React from 'react';
import { useAtomValue } from 'jotai';
import { webPageDetails, type ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { externalReferenceItemMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { formatRegistryDate } from '@beaver/agent-core/citations/externalRecordDisplay';
import { urlNamesPdf } from '@beaver/agent-core/identity/webPages';
import { getHost } from '@beaver/agent-ui/host';
import { useItemContextMenu } from '@beaver/agent-ui/chat/useItemContextMenu';
import { GlobeIcon, Icon, PdfIcon } from '@beaver/agent-ui/icons';
import { openExternal } from './ExternalRecordParts';

interface WebPageRowLayoutProps {
    title: string;
    /** Second line, e.g. "who.int · Mar 1, 2024". */
    meta?: string | null;
    url?: string | null;
    /** Defaults to whether the URL names a PDF. */
    isPdf?: boolean;
    /** Drawn faded, e.g. a page the tool failed on. */
    faded?: boolean;
    /** Controls at the row's end; their clicks don't open the page. */
    trailing?: React.ReactNode;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onContextMenu?: (event: React.MouseEvent) => void;
}

/**
 * One web page in a tool result, laid out like an item row: the page icon,
 * the title, and the site on a second line. The click opens the page.
 */
export const WebPageRowLayout: React.FC<WebPageRowLayoutProps> = ({
    title,
    meta,
    url,
    isPdf,
    faded = false,
    trailing,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    onContextMenu,
}) => (
    <div
        className={`display-flex flex-row items-start gap-25 p-2 transition-colors ${url ? 'cursor-pointer' : ''} ${isHovered ? 'bg-quinary' : ''} ${faded ? 'opacity-50' : ''}`}
        onClick={url ? () => openExternal(url) : undefined}
        onContextMenu={onContextMenu}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        title={url ?? undefined}
    >
        {/* A web glyph, not Zotero's item-type icon: a library icon would say the page is in the library. */}
        <div className="display-flex items-center justify-center flex-shrink-0 ml-05" style={{ width: 16, height: 18 }}>
            <Icon icon={isPdf ?? (!!url && urlNamesPdf(url)) ? PdfIcon : GlobeIcon} size={15} className="font-color-secondary" />
        </div>
        <div className="display-flex flex-col flex-1 gap-05 min-w-0">
            <div className="truncate font-color-primary" style={{ fontSize: '0.925rem' }}>
                {title}
            </div>
            {meta && <div className="truncate text-sm font-color-secondary">{meta}</div>}
        </div>
        {trailing && (
            <div
                className="flex-shrink-0 display-flex items-center"
                style={{ alignSelf: 'center' }}
                onClick={(event) => event.stopPropagation()}
            >
                {trailing}
            </div>
        )}
    </div>
);

interface WebPageListItemProps {
    item: ExternalReference;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

/**
 * A web page from web search, or a page the agent read. Import shows on
 * hover; once the page is in the library, its reveal control stays and the
 * row gets the item menu.
 */
const WebPageListItem: React.FC<WebPageListItemProps> = ({ item, isHovered, onMouseEnter, onMouseLeave }) => {
    const itemMapping = useAtomValue(externalReferenceItemMappingAtom);
    const libraryItem = (item.source_id && itemMapping[item.source_id]) || item.library_items?.[0];
    const { openItemMenu, itemMenu } = useItemContextMenu();
    const details = webPageDetails(item);
    const url = item.url || undefined;
    const site = details?.site_name || details?.site || null;
    const date = formatRegistryDate(item.publication_date) || (item.year ? String(item.year) : null);
    const actions = getHost().components?.externalReferenceActions({
        item,
        buttonVariant: 'ghost-secondary',
        importButtonMode: 'icon-only',
        revealButtonMode: 'icon-only',
        detailsButtonMode: 'none',
        webButtonMode: 'none',
        pdfButtonMode: 'none',
        showCitationCount: false,
    });

    return (
        <>
            <WebPageRowLayout
                title={item.title || site || url || item.source_id || 'Web page'}
                meta={[site, date].filter(Boolean).join(' · ')}
                url={url}
                isPdf={details?.content_type === 'pdf' || (!!url && urlNamesPdf(url))}
                trailing={actions && (
                    // Hidden, not removed, off hover: the control keeps its library check.
                    <div style={{ visibility: isHovered || libraryItem ? 'visible' : 'hidden' }}>{actions}</div>
                )}
                isHovered={isHovered}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
                onContextMenu={libraryItem ? (event) => openItemMenu(libraryItem, event) : undefined}
            />
            {itemMenu}
        </>
    );
};

export default WebPageListItem;
