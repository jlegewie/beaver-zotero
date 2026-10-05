import { getPref } from "../utils/prefs";

const DEFAULT_STYLE_ID = "http://www.zotero.org/styles/chicago-author-date";

/**
 * Citation object
 */
export type Citation = {
    id: number;
    locator?: string;
    label?: string;
    prefix?: string;
    suffix?: string;
    suppressAuthor?: boolean;
    authorOnly?: boolean;
}

/** One item of a citation cluster in a sequence. */
export type SequenceCitationItem = {
    /** Library item id, or a key of `embeddedItems`. */
    id: number | string;
    locator?: string;
    label?: string;
};

export type CitationSequenceRequest = {
    /** Defaults to the `citationStyle` preference. */
    styleId?: string;
    /** Defaults to the `citationLocale` preference. */
    locale?: string;
    /** Clusters in document order. Empty clusters are skipped. */
    clusters: Array<{ items: SequenceCitationItem[]; noteIndex: number }>;
    /** CSL-JSON of items that are not library items, by processor id. */
    embeddedItems: Record<string, Record<string, unknown>>;
};

export type CitationSequenceResult = {
    styleId: string;
    locale: string;
    styleClass: "in-text" | "note";
    /** The style's CSL citation format (`author-date`, `numeric`, `note`, …), when it declares one. */
    citationFormat: string | null;
    /** Whether the style defines a bibliography. */
    hasBibliography: boolean;
    /** Aligned with the request's clusters; null for empty clusters. */
    clusters: Array<{ html: string; rtf: string } | null>;
    /** CSL-JSON the processor used, by processor id (as a string). */
    itemData: Record<string, Record<string, unknown>>;
    /** Bibliography entries (HTML) and Zotero's paragraph layout for them, in twips. */
    bibliography: {
        entries: string[];
        layout: { indent: number; firstLineIndent: number; lineSpacing: number; entrySpacing: number; tabStops: number[] };
    } | null;
};

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
     * Format an in-text citation for either based on an array of Zotero items or an array of citation objects
     * @param items Single Zotero item or array of items to format
     * @param clean If true, removes parentheses and normalizes quotes
     * @returns Formatted in-text citation or empty string on error
     */
    public formatCitation(items: Zotero.Item | Zotero.Item[], clean?: boolean): string;
    public formatCitation(citationItems: Citation[], clean?: boolean): string;
    public formatCitation(
        itemsOrCitationItems?: Zotero.Item | Zotero.Item[] | Citation[],
        clean: boolean = false
    ): string {
        if (!itemsOrCitationItems) return "";

        // Determine if the input is an array of Zotero items
        const isItems =
            itemsOrCitationItems instanceof Zotero.Item ||
            (
                Array.isArray(itemsOrCitationItems) &&
                itemsOrCitationItems.length > 0 &&
                itemsOrCitationItems[0] instanceof Zotero.Item
            );

        try {
            const engine = this.getCitationProcessor();
            if (!engine) {
                this.ztoolkit.log("Error: No CSL engine available");
                return "";
            }

            // Create a citation object with all items
            let citationItems: Citation[] = [];
            if (isItems) {
                const itemsArray = Array.isArray(itemsOrCitationItems) ? itemsOrCitationItems : [itemsOrCitationItems];
                citationItems = itemsArray.map(item => ({ id: item.id }));
            } else {
                citationItems = itemsOrCitationItems;
            }

            // Create a citation object with all items
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
    public formatBibliography(items: Zotero.Item | Zotero.Item[], format: "text" | "html" = "text"): string {
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
            const bibliography = Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, itemsArray, format).trim();
            return bibliography;

        } catch (e) {
            this.ztoolkit.log(`Error formatting bibliography: ${e}`);
            return "";
        }
    }

    /**
     * The installed style and locale to format with: the requested ones, else
     * the `citationStyle` / `citationLocale` preferences. A style that is not
     * installed falls back to the default style.
     */
    public resolveStyle(styleId?: string, locale?: string): { style: any; locale: string } {
        const requestedStyle = styleId || getPref("citationStyle") || DEFAULT_STYLE_ID;
        let style = Zotero.Styles.get(requestedStyle);
        if (!style) {
            this.ztoolkit.log(`CitationService: style ${requestedStyle} not found, using ${DEFAULT_STYLE_ID}`);
            style = Zotero.Styles.get(DEFAULT_STYLE_ID);
        }
        return { style, locale: locale || getPref("citationLocale") || "en-US" };
    }

    /**
     * Format a whole document's citations as one sequence, so the style's
     * cross-citation rules apply: disambiguation (2004a/b), subsequent and
     * "Ibid." forms in note styles, and citation-order numbering.
     *
     * Uses a fresh engine per call — cached engines are shared with Zotero's
     * own callers. Items without a library item (embedded CSL-JSON) are served
     * by wrapping the engine's item retrieval, so they are disambiguated and
     * numbered together with library items.
     */
    public formatCitationSequence(request: CitationSequenceRequest): CitationSequenceResult {
        const { style, locale } = this.resolveStyle(request.styleId, request.locale);
        const automaticJournalAbbreviations = !!Zotero.Prefs.get("cite.automaticJournalAbbreviations");
        const createEngine = (format: "html" | "rtf") => {
            const engine = style.getCiteProc(locale, format, { automaticJournalAbbreviations });
            const retrieveItem = engine.sys.retrieveItem.bind(engine.sys);
            engine.sys.retrieveItem = (id: number | string) => {
                const embedded = typeof id === "string" ? request.embeddedItems[id] : undefined;
                // citeproc annotates the objects it is given; hand it a copy.
                return embedded ? { ...JSON.parse(JSON.stringify(embedded)), id } : retrieveItem(id);
            };
            return engine;
        };

        const included = request.clusters
            .map((cluster, index) => ({ cluster, index }))
            .filter(({ cluster }) => cluster.items.length > 0);
        const citations = included.map(({ cluster, index }) => ({
            citationID: `c${index}`,
            citationItems: cluster.items.map(item => ({
                id: item.id,
                ...(item.locator ? { locator: item.locator, label: item.label ?? "page" } : {}),
            })),
            properties: { noteIndex: cluster.noteIndex },
        }));

        const htmlEngine = createEngine("html");
        const rtfEngine = createEngine("rtf");
        const byCitationID = (rows: Array<[string, number, string]>) => new Map(rows.map(row => [row[0], row[2]]));
        const html = byCitationID(citations.length ? htmlEngine.rebuildProcessorState(citations, "html", []) : []);
        const rtf = byCitationID(citations.length ? rtfEngine.rebuildProcessorState(citations, "rtf", []) : []);

        const clusters = request.clusters.map((cluster, index) => {
            if (cluster.items.length === 0) return null;
            const id = `c${index}`;
            return { html: html.get(id) ?? "", rtf: rtf.get(id) ?? "" };
        });

        const itemData: Record<string, Record<string, unknown>> = {};
        for (const citation of citations) {
            for (const item of citation.citationItems) {
                const key = String(item.id);
                if (!itemData[key]) itemData[key] = htmlEngine.sys.retrieveItem(item.id);
            }
        }

        let bibliography: CitationSequenceResult["bibliography"] = null;
        const hasBibliography = !!style.hasBibliography;
        if (hasBibliography && citations.length > 0) {
            const bib = htmlEngine.makeBibliography();
            if (bib && Array.isArray(bib[1]) && bib[1].length > 0) {
                const layout = Zotero.Cite.getBibliographyFormatParameters(bib);
                bibliography = { entries: bib[1], layout };
            }
        }

        return {
            styleId: style.styleID,
            locale,
            styleClass: htmlEngine.opt.class === "note" ? "note" : "in-text",
            citationFormat: typeof style.categories === "string" && style.categories ? style.categories : null,
            hasBibliography,
            clusters,
            itemData,
            bibliography,
        };
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