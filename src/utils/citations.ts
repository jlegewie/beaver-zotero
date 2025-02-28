import { truncateText } from "../../react/utils/truncateText";

export interface ZoteroStyle {
    getCiteProc(locale: string, format: 'text' | 'html'): CSLEngine;
}

interface CSLEngine {
    updateItems(ids: number[]): void;
    previewCitationCluster(
        citation: CSLCitation,
        citationsPre: any[],
        citationsPost: any[],
        format: 'text' | 'html'
    ): string;
    free(): void;
}

interface CSLCitation {
    citationItems: Array<{
        id: number;
        [key: string]: any;
    }>;
    properties: {
        inText?: boolean;
        [key: string]: any;
    };
}

interface FormattedReference {
    inTextCitation: string;
    bibliography: string;
}

export function getInTextCitations(
    items: Zotero.Item[],
    style: string = 'http://www.zotero.org/styles/chicago-author-date'
): string[] {
    if (items.length === 0) {
        return [];
    }
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    const cslEngine = csl_style.getCiteProc('en-US', 'text');
    
    const citations = items.map(item => {
        const citation: CSLCitation = {
            citationItems: [{ id: item.id }],
            properties: { inText: true }
        };
        const citation_formatted = cslEngine.previewCitationCluster(citation, [], [], "text")
            .replace(/^\(|\)$/g, '')
            .replace(/n\.d\.$/, '')
            // .replace(/ et al\./g, '+')
            .trim()
            .replace(/,$/, '')
            .replace(/”/g, '"')
            .replace(/“/g, '"')
            .replace(/,"$/, '"');

        return truncateText(citation_formatted, 25);
    });
    
    cslEngine.free();
    return citations;
}

export function getAuthorYearCitationFromStyle(
    item: Zotero.Item,
    style: string = 'http://www.zotero.org/styles/chicago-author-date',
    locale: string = 'en-US'
): string {
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    const cslEngine = csl_style.getCiteProc(locale, 'text');
    const citation = getAuthorYearCitation(item, cslEngine);
    cslEngine.free();
    return citation;
}

export function getAuthorYearCitation(
    item: Zotero.Item,
    cslEngine: CSLEngine
): string {    
    const citation: CSLCitation = {
        citationItems: [{ id: item.id }],
        properties: { inText: true }
    };
    const citation_formatted = cslEngine.previewCitationCluster(citation, [], [], "text")
        .replace(/^\(|\)$/g, '')
        .trim()
        .replace(/,$/, '')
        .replace(/”/g, '"')
        .replace(/“/g, '"')
        .replace(/,"$/, '"');

    return citation_formatted;
}

export function getBibliography(
    item: Zotero.Item,
    style: string = 'http://www.zotero.org/styles/chicago-author-date'
): string {
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    const cslEngine = csl_style.getCiteProc('en-US', 'text');
    
    const bibliography = Zotero.Cite.makeFormattedBibliographyOrCitationList(cslEngine, [item], "text").trim();
    
    cslEngine.free();
    return bibliography;
}

export function getBibliographies(
    items: Zotero.Item[],
    style: string = 'http://www.zotero.org/styles/chicago-author-date'
): string[] {
    if (items.length === 0) {
        return [];
    }
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    const cslEngine = csl_style.getCiteProc('en-US', 'text');
    
    const bibliographies = items.map(item => 
        Zotero.Cite.makeFormattedBibliographyOrCitationList(cslEngine, [item], "text").trim()
    );
    
    cslEngine.free();
    return bibliographies;
}

export function getFormattedReferences(
    items: Zotero.Item[],
    style: string = 'http://www.zotero.org/styles/chicago-author-date'
): FormattedReference[] {
    if (items.length === 0) {
        return [];
    }
    const inTextCitations = getInTextCitations(items, style);
    const bibliographies = getBibliographies(items, style);
    
    return items.map((_, index) => ({
        inTextCitation: inTextCitations[index],
        bibliography: bibliographies[index]
    }));
}