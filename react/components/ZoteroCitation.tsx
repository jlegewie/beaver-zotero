import React from 'react';
import Tooltip from './Tooltip';
import { useAtomValue } from 'jotai';
import { threadFlattenedSourcesWithCitationsAtom } from '../atoms/threads';
import { getPref } from '../../src/utils/prefs';
import { parseZoteroURI } from '../utils/parseZoteroURI';
import { citationDataFromItem } from '../utils/citationFormatting';

const TOOLTIP_WIDTH = '250px';

// Define prop types for the component
interface ZoteroCitationProps {
    id: string;           // Format: "libraryID-itemKey" (and 'user-content-' from sanitization)
    pages?: string;       // Format: "3-6,19"
    consecutive?: boolean;
    children?: React.ReactNode;
    tooltip?: boolean;
}

const ZoteroCitation: React.FC<ZoteroCitationProps> = ({ 
    id,
    pages = '',
    consecutive = false,
    children,
    tooltip = true,
}) => {
    // Get the sources from atom state
    const sources = useAtomValue(threadFlattenedSourcesWithCitationsAtom);

    // Get the citation format preference
    const authorYearFormat = getPref("citationFormat") !== "numeric";
    
    // Parse the id to get libraryID and itemKey
    id = id.replace('user-content-', '');
    const [libraryIDString, itemKey] = id.includes('-') ? id.split('-') : [id, id];
    const libraryID = parseInt(libraryIDString) || 1;

    // Find the source in the available sources
    const source = sources.find(
        s => s.type === 'zotero_item' && 
        (s.itemKey === itemKey || s.childItemKeys?.includes(itemKey)) && 
        s.libraryID === libraryID
    );
    // const fileSource = sources.find(s => s.type === 'file' && (s as FileSource).id === idParts);

    // Get citation data
    let reference = '';
    let citation = '';
    let url = '';

    // If we have a source, use it
    if (source) {
        reference = source.reference;
        citation = source.citation;
        url = source.url;
    // Fallback: get the Zotero item and create the citation data
    } else {
        // Get the Zotero item
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) {
            console.log('Failed to format citation for id:', id);
            return null;
        }

        // Citation preferences
        const style = getPref("citationStyle") || 'http://www.zotero.org/styles/chicago-author-date';
        const locale = getPref("citationLocale") || 'en-US';

        // Get the citation data
        ({ citation, reference, url } = citationDataFromItem(item, null, style, locale));
        
    }
    
    // Add the URL to open the PDF/Note
    const firstPage = pages ? parseInt(pages.split(/[-,]/)[0]) : null;
    url = firstPage ? `${url}?page=${firstPage}` : url;
    
    // Handle click on citation
    const handleClick = async (e: React.MouseEvent) => {
        if (url.startsWith('zotero://open-note')) {
            e.preventDefault();

            // Get the item key and library ID from the data attributes
            let itemKey: string | null = (e.target as HTMLElement).dataset.itemKey || null;
            let libraryID: number | null = parseInt((e.target as HTMLElement).dataset.libraryId || '0');
            // Fallback: parse the URL if the data attributes are not set
            if (!libraryID || !itemKey) {
                ({ libraryID, itemKey } = parseZoteroURI(url));
            }
            if (!libraryID || !itemKey) return;
            
            // Get the item
            const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
            if (!item) return;

            // Open the note window
            if (item.isNote()) {
                await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
            } else {
                await Zotero.getActiveZoteroPane().selectItem(item.id);
            }
        } else if (url.startsWith('file:///')) {
            e.preventDefault();
            const filePath = url.replace('file:///', '');
            Zotero.launchFile(filePath);
        }
        // Default behavior for zotero://open-pdf, zotero://select and other protocols
    };

    // Format for display
    let displayText = '';
    if (authorYearFormat) {
        displayText = consecutive
            ? (pages ? `p.${pages}` : 'Ibid')
            : (pages ? `${citation}, p.${pages}` : citation);
    } else {
        displayText = source?.numericCitation || citation;
    }

    const citationElement = (
        <a 
            href={url} 
            onClick={handleClick} 
            className="zotero-citation"
            data-pages={pages}
            data-item-key={itemKey}
            data-library-id={libraryID}
            >
            {displayText}
        </a>
    );
    
    // Return the citation with tooltip and click handler
    return (
        <>
            {tooltip && (
                <Tooltip content={reference} width={TOOLTIP_WIDTH}>
                    {citationElement}
                </Tooltip>
            )}
            {!tooltip && citationElement}
        </>
    );

};

export default ZoteroCitation;