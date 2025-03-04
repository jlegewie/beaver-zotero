import React from 'react';
import Tooltip from './Tooltip';
import { useAtomValue } from 'jotai';
import { flattenedThreadSourcesAtom } from '../atoms/threads';
import { getPref } from '../../src/utils/prefs';
import { parseZoteroURI } from '../utils/zoteroURI';
import { getCitationFromItem, getReferenceFromItem } from '../utils/sourceUtils';
import { createZoteroURI } from '../utils/zoteroURI';

const TOOLTIP_WIDTH = '250px';

// Define prop types for the component
interface ZoteroCitationProps {
    id: string;           // Format: "libraryID-itemKey" (and 'user-content-' from sanitization)
    pages?: string;       // Format: "3-6,19"
    consecutive?: boolean;
    children?: React.ReactNode;
    exportRendering?: boolean;
}

const ZoteroCitation: React.FC<ZoteroCitationProps> = ({ 
    id,
    pages = '',
    consecutive = false,
    children,
    exportRendering = false
}) => {
    // Get the sources from atom state
    const sources = useAtomValue(flattenedThreadSourcesAtom);

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

        // Get the citation data
        citation = getCitationFromItem(item);
        reference = getReferenceFromItem(item);
        url = createZoteroURI(item);
    }
    
    // Add the URL to open the PDF/Note
    const firstPage = pages ? parseInt(pages.split(/[-,]/)[0]) : null;
    url = firstPage ? `${url}?page=${firstPage}` : url;
    
    // Handle click on citation
    const handleClick = async (e: React.MouseEvent) => {
        // Handle file links
        if (url.startsWith('file:///')) {
            e.preventDefault();
            const filePath = url.replace('file:///', '');
            Zotero.launchFile(filePath);
            return;
        }

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

        // Handle note links
        if (item.isNote()) {
            e.preventDefault();
            // Open the note window
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
            // await Zotero.getActiveZoteroPane().selectItem(item.id);
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
    if (exportRendering) {
        displayText = authorYearFormat ? ` (${displayText})` : ` [${displayText}]`;
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
            {exportRendering ?
                citationElement
            :
                <Tooltip content={reference} width={TOOLTIP_WIDTH}>
                    {citationElement}
                </Tooltip>
            }
        </>
    );

};

export default ZoteroCitation;