interface ZoteroStyle {
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

function getFormattedReferences(
    items: Zotero.Item[],
    style: string = 'http://www.zotero.org/styles/chicago-author-date'
): FormattedReference[] {
    // Get the style
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    const locale = 'en-US';
    
    // Process in-text citations
    let cslEngine = csl_style.getCiteProc(locale, 'text');
    const inTextCitations = items.map(item => {
        const citation: CSLCitation = {
            citationItems: [{ id: item.id }],
            properties: { inText: true }
        };
        return cslEngine.previewCitationCluster(citation, [], [], "text")
            .replace(/^\(|\)$/g, '');
    });
    cslEngine.free();
    
    // Process bibliographies
    cslEngine = csl_style.getCiteProc(locale, 'text');
    const bibliographies = items.map(item => 
        Zotero.Cite.makeFormattedBibliographyOrCitationList(cslEngine, [item], "text").trim()
    );
    cslEngine.free();
    
    // Combine results
    return items.map((_, index) => ({
        inTextCitation: inTextCitations[index],
        bibliography: bibliographies[index]
    }));
}