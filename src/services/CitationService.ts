import { getPref } from "../utils/prefs";

/**
 * Service for formatting citations using CSL
 * Caches the CSL engine for better performance
 */
export class CitationService {
    private _cslEngine: any = null;
    private _styleID: string | null = null;
    private _locale: string | null = null;
    private ztoolkit: any;

    /**
     * Initialize the Citation Service
     * @param ztoolkit ZToolkit instance for logging
     */
    constructor(ztoolkit: any) {
        this.ztoolkit = ztoolkit;
        this.ztoolkit.log("CitationService initialized");
    }

    /**
     * Get a cached CSL citation processor
     * Creates a new one only if needed (style or locale changed)
     * @returns CSL citation processor or null if creation fails
     */
    private getCitationProcessor() {
        const style = getPref("citationStyle");
        const locale = getPref("citationLocale");

        // Only recreate if style or locale changed, or engine doesn't exist
        if (!this._cslEngine || this._styleID !== style || this._locale !== locale) {
            try {
                this.ztoolkit.log(`Creating new CSL engine for style: ${style}, locale: ${locale}`);
                const cslStyle = Zotero.Styles.get(style);
                if (!cslStyle) {
                    this.ztoolkit.log(`Warning: Style ${style} not found, using default style`);
                    // Fallback to a default style
                    const defaultStyle = "http://www.zotero.org/styles/chicago-author-date";
                    this._cslEngine = Zotero.Styles.get(defaultStyle).getCiteProc(locale, 'text');
                    this._styleID = defaultStyle;
                } else {
                    this._cslEngine = cslStyle.getCiteProc(locale, 'text');
                    this._styleID = style;
                }
                this._locale = locale;
            } catch (e) {
                this.ztoolkit.log(`Error creating CSL engine: ${e}`);
                return null;
            }
        }
        return this._cslEngine;
    }

    /**
     * Format an in-text citation for one or multiple Zotero items
     * @param items Single Zotero item or array of items to format
     * @param clean If true, removes parentheses and normalizes quotes
     * @returns Formatted in-text citation or empty string on error
     */
    public formatCitation(items: Zotero.Item | Zotero.Item[], clean: boolean = false): string {
        if (!items) return "";

        // Convert single item to array for unified processing
        const itemsArray = Array.isArray(items) ? items : [items];

        try {
            const engine = this.getCitationProcessor();
            if (!engine) {
                this.ztoolkit.log("Error: No CSL engine available");
                return "";
            }

            // Get the IDs and update the processor
            const itemIds = itemsArray.map(item => item.id);
            engine.updateItems(itemIds);

            // Create a citation object with all items
            const citationItems = itemIds.map(id => ({ id }));
            const citation = {
                /* Citation Item Properties
                * - id: The item ID (required)
                * - locator: Page number or other locator (e.g., "42")
                * - label: Type of locator (e.g., "page", "chapter", "section")
                * - prefix: Text to display before the citation
                * - suffix: Text to display after the citation
                * - suppress-author: Boolean to suppress the author name (shows only year)
                * - author-only: Boolean to display only the author name
                */
                citationItems,
                /* Citation-level Properties
                * - mode: Controls overall citation formatting
                *     "default": Author and year in parentheses (default)
                *     "author-only": Displays author names without parentheses (narrative citation)
                *     "suppress-author": Omits author names, displays only year in parentheses
                *     "composite": Author with year in parentheses
                * - prefix: Text to appear before the entire citation
                * - suffix: Text to appear after the entire citation
                */
                properties: {}
            };

            // Get the citation text
            let result = engine.previewCitationCluster(citation, [], [], "text");

            if (clean) {
                result = this.cleanCitationFormatting(result);
            }
            return result;
        } catch (e) {
            this.ztoolkit.log(`Error formatting citation: ${e}`);
            return "";
        }
    }

    /**
     * Clean citation formatting - removes parentheses, normalizes quotes, etc.
     * @param citation The citation string to clean
     * @returns Cleaned citation string
     */
    private cleanCitationFormatting(citation: string): string {
        return citation
            .trim()
            .replace(/^\(|\)$/g, '')    // Remove opening and closing parentheses
            .replace(/,? ?n\.d\.$/, '') // Remove n.d.
            .replace(/,$/, '')          // Remove trailing comma
            .replace(/”/g, '"')         // Normalize opening quotes
            .replace(/“/g, '"')         // Normalize closing quotes
            .replace(/,"$/, '"');       // Fix comma-quote pattern
    }

    /**
     * Format multiple items as a bibliography entry
     * @param items Array of Zotero items
     * @returns Formatted bibliography HTML or empty string on error
     */
    public formatBibliography(items: Zotero.Item | Zotero.Item[]): string {
        if (!items) return "";

        // Convert single item to array for unified processing
        const itemsArray = Array.isArray(items) ? items : [items];

        try {
            const engine = this.getCitationProcessor();
            if (!engine) {
                this.ztoolkit.log("Error: No CSL engine available");
                return "";
            }

            // Generate bibliography
            const bibliography = Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, itemsArray, "text").trim();
            return bibliography;

        } catch (e) {
            this.ztoolkit.log(`Error formatting bibliography: ${e}`);
            return "";
        }
    }

    /**
     * Force recreation of the CSL engine on next use
     * Call this when preferences change
     */
    public reset(): void {
        this._cslEngine = null;
        this._styleID = null;
        this._locale = null;
        this.ztoolkit.log("CSL engine cache reset");
    }

    /**
     * Free resources when the service is no longer needed
     * Call during plugin shutdown
     */
    public dispose(): void {
        this._cslEngine = null;
        this._styleID = null;
        this._locale = null;
        this.ztoolkit.log("CitationService disposed");
    }
} 