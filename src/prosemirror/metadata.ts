/**
 * Simplified Metadata class for ProseMirror normalization.
 * Adapted from zotero/note-editor src/core/schema/metadata.js (AGPL-3.0).
 *
 * Only includes methods needed for the HTML→ProseMirror→HTML roundtrip:
 * parseAttributes, serializeAttributes, fillCitationItemsWithData.
 */

interface CitationItem {
    uris: string[];
    itemData?: any;
    [key: string]: any;
}

export class Metadata {
    private _schemaVersion: number;
    private _citationItems: CitationItem[];

    constructor(private currentSchemaVersion: number) {
        this._schemaVersion = 0;
        this._citationItems = [];
    }

    get schemaVersion(): number {
        return this._schemaVersion;
    }

    get citationItems(): CitationItem[] {
        return this._citationItems;
    }

    serializeAttributes(): Record<string, string> {
        const attributes: Record<string, string> = {};

        attributes['data-schema-version'] = this.currentSchemaVersion.toString();

        if (this._citationItems.length) {
            attributes['data-citation-items'] = encodeURIComponent(JSON.stringify(this._citationItems));
        }

        return attributes;
    }

    parseAttributes(attributes: Record<string, string>): void {
        // schemaVersion
        try {
            let schemaVersion: string | number | undefined = attributes['data-schema-version'];
            if (schemaVersion) {
                schemaVersion = parseInt(schemaVersion as string);
                if (Number.isInteger(schemaVersion)) {
                    this._schemaVersion = schemaVersion;
                }
            }
        }
        catch (e) {
            // Intentionally swallow
        }

        // citationItems
        try {
            const raw = attributes['data-citation-items'];
            if (raw) {
                const citationItems = JSON.parse(decodeURIComponent(raw));
                if (Array.isArray(citationItems)) {
                    this._citationItems = citationItems;
                }
            }
        }
        catch (e) {
            // Intentionally swallow
        }
    }

    fillCitationItemsWithData(citationItems: CitationItem[]): void {
        for (const citationItem of citationItems) {
            const item = this._citationItems
                .find(i => i.uris.some(uri => citationItem.uris.includes(uri)));

            if (item) {
                citationItem.itemData = item.itemData;
            }
        }
    }

    fromJSON(json: { schemaVersion: number; citationItems: CitationItem[] }): void {
        this._schemaVersion = json.schemaVersion;
        this._citationItems = json.citationItems;
    }

    toJSON(): { schemaVersion: number; citationItems: CitationItem[] } {
        return {
            schemaVersion: this._schemaVersion,
            citationItems: this._citationItems
        };
    }
}
