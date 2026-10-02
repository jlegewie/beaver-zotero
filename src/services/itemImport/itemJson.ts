/**
 * Validation and normalization of Zotero item JSON, without writing anything.
 *
 * `Zotero.Item.fromJSON` on an unsaved item is Zotero's own validator: in
 * non-strict mode it moves unknown fields, and fields invalid for the item
 * type, into Extra (`Field: value`), and maps base fields to their
 * type-specific names. `toJSON` then shows exactly what would be saved. Every
 * resolved item (translator output, model metadata, fallback metadata) goes
 * through here, so the approval card shows what gets written.
 */

import type { ZoteroItemJson } from '@beaver/agent-core/types/itemImport';

/** Keys that describe transport or identity, never item content. */
const TRANSPORT_KEYS = [
    'attachments',
    'seeAlso',
    'id',
    'itemID',
    'key',
    'version',
    'accessDate',
    'dateAdded',
    'dateModified',
    'collections',
    'relations',
    'deleted',
    'inPublications',
    'parentItem',
    'libraryCatalog_',
    'complete',
    'itemKey',
] as const;

/** Item types the model is told about, listed when it names an unknown one. */
const COMMON_ITEM_TYPES = [
    'journalArticle', 'book', 'bookSection', 'report', 'thesis', 'webpage', 'preprint',
    'conferencePaper', 'document', 'magazineArticle', 'newspaperArticle', 'blogPost',
    'dataset', 'presentation', 'manuscript', 'encyclopediaArticle',
];

export type NormalizeResult =
    | { ok: true; item: ZoteroItemJson; warnings: string[] }
    | { ok: false; code: 'invalid_metadata'; message: string };

function isNonEmpty(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
}

/** Normalize tags (strings or objects) to `{tag, type}` with a non-empty name. */
export function normalizeTags(tags: unknown, type: 0 | 1 = 1): Array<{ tag: string; type: 0 | 1 }> {
    if (!Array.isArray(tags)) return [];
    const out: Array<{ tag: string; type: 0 | 1 }> = [];
    const seen = new Set<string>();
    for (const tag of tags) {
        const name = typeof tag === 'string' ? tag : (tag && typeof tag === 'object' ? (tag as any).tag : undefined);
        if (typeof name !== 'string' || !name.trim() || seen.has(name.trim())) continue;
        seen.add(name.trim());
        out.push({ tag: name.trim(), type });
    }
    return out;
}

function normalizeNotes(notes: unknown): Array<{ note: string }> {
    if (!Array.isArray(notes)) return [];
    return notes
        .map((note) => (typeof note === 'string' ? note : (note && typeof note === 'object' ? (note as any).note : undefined)))
        .filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
        .map((note) => ({ note }));
}

function normalizeCreators(creators: unknown, warnings: string[]): any[] {
    if (!Array.isArray(creators)) return [];
    const out: any[] = [];
    let defaulted = false;
    for (const raw of creators) {
        if (!raw || typeof raw !== 'object') continue;
        const creator: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
        // Translators mark single-field (institutional) creators with fieldMode 1.
        if (creator.fieldMode === 1 && typeof creator.lastName === 'string' && creator.lastName.trim()) {
            creator.name = creator.lastName;
            delete creator.lastName;
            delete creator.firstName;
        }
        delete creator.fieldMode;
        const name = typeof creator.name === 'string' ? creator.name.trim() : '';
        const first = typeof creator.firstName === 'string' ? creator.firstName.trim() : '';
        const last = typeof creator.lastName === 'string' ? creator.lastName.trim() : '';
        if (!name && !first && !last) continue;
        if (typeof creator.creatorType !== 'string' || !creator.creatorType) {
            creator.creatorType = 'author';
            defaulted = true;
        }
        if (name && !first && !last) {
            out.push({ creatorType: creator.creatorType, name });
        } else {
            // A first name alone is stored single-field so it is not lost.
            out.push(last
                ? { creatorType: creator.creatorType, firstName: first, lastName: last }
                : { creatorType: creator.creatorType, name: first || name });
        }
    }
    if (defaulted) warnings.push('creators without a role were added as authors');
    return out;
}

/** Base fields whose type-specific variants (university, institution, bookTitle, …) are interchangeable. */
const BASE_FIELDS = ['publisher', 'publicationTitle', 'number', 'type', 'medium', 'title', 'date'];

/**
 * Move a field that belongs to another item type onto this type's variant of
 * the same base field (e.g. `university` on a report becomes `institution`),
 * instead of letting Zotero park it in Extra. Only fills an empty target.
 */
function remapBaseFields(json: Record<string, any>, itemType: string, warnings: string[]): void {
    const fields = Zotero.ItemFields as any;
    const typeID = Zotero.ItemTypes.getID(itemType);
    const required = ['getID', 'getName', 'isValidForType', 'getFieldIDFromTypeAndBase', 'getTypeFieldsFromBase'];
    if (!typeID || required.some((name) => typeof fields[name] !== 'function')) return;
    for (const base of BASE_FIELDS) {
        const baseID = fields.getID(base);
        if (!baseID) continue;
        const targetID = fields.getFieldIDFromTypeAndBase(typeID, baseID)
            || (fields.isValidForType(baseID, typeID) ? baseID : null);
        if (!targetID) continue;
        const target = fields.getName(targetID) as string;
        const variants: string[] = [base, ...(fields.getTypeFieldsFromBase(baseID, true) ?? [])];
        for (const variant of variants) {
            if (variant === target || !isNonEmpty(json[variant])) continue;
            const variantID = fields.getID(variant);
            if (variantID && fields.isValidForType(variantID, typeID)) continue;
            if (!isNonEmpty(json[target])) {
                json[target] = json[variant];
                warnings.push(`${variant} stored as ${target}`);
            }
            delete json[variant];
        }
    }
}

/**
 * Validate and normalize item JSON for `libraryID` without saving.
 *
 * - Strips transport keys (`attachments`, `seeAlso`, `id`, `accessDate`, …);
 *   a fresh `accessDate` is added at write time for web content.
 * - Keeps `notes` (written as child notes) and normalizes tags to objects.
 * - Fails with `invalid_metadata` on a missing or unknown `itemType`.
 * - Reports fields Zotero moved to Extra, and creator fixes, as warnings.
 */
export function normalizeItemJson(input: ZoteroItemJson | Record<string, unknown>, libraryID?: number): NormalizeResult {
    const json: Record<string, any> = { ...(input as Record<string, unknown>) };
    const itemType = typeof json.itemType === 'string' ? json.itemType.trim() : '';
    if (!itemType || !Zotero.ItemTypes.getID(itemType) || itemType === 'note' || itemType === 'attachment' || itemType === 'annotation') {
        return {
            ok: false,
            code: 'invalid_metadata',
            message: itemType
                ? `Unknown or unsupported itemType '${itemType}'. Use one of: ${COMMON_ITEM_TYPES.join(', ')}.`
                : `itemType is required. Use one of: ${COMMON_ITEM_TYPES.join(', ')}.`,
        };
    }

    const warnings: string[] = [];
    const notes = normalizeNotes(json.notes);
    const tags = normalizeTags(json.tags);
    for (const key of TRANSPORT_KEYS) delete json[key];
    delete json.notes;
    json.itemType = itemType;
    json.tags = tags;
    json.creators = normalizeCreators(json.creators, warnings);
    for (const [key, value] of Object.entries(json)) {
        if (typeof value === 'number' && Number.isFinite(value)) json[key] = String(value);
        else if (!isNonEmpty(value) && key !== 'tags' && key !== 'creators') delete json[key];
    }

    remapBaseFields(json, itemType, warnings);

    let output: Record<string, any>;
    try {
        const item = new Zotero.Item(itemType as any);
        item.libraryID = libraryID ?? Zotero.Libraries.userLibraryID;
        item.fromJSON(json as any);
        output = item.toJSON() as Record<string, any>;
    } catch (error) {
        return {
            ok: false,
            code: 'invalid_metadata',
            message: `Zotero rejected the metadata: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    for (const key of TRANSPORT_KEYS) delete output[key];
    for (const [key, value] of Object.entries(output)) {
        if (!isNonEmpty(value) && key !== 'itemType') delete output[key];
    }

    // Fields Zotero could not keep as fields went to Extra (de-duplicated by
    // base field): report the Extra lines the round trip added.
    const extraLines = (value: unknown) => (typeof value === 'string' ? value.split('\n').map((line) => line.trim()).filter(Boolean) : []);
    const before = new Set(extraLines(json.extra));
    const moved = extraLines(output.extra)
        .filter((line) => !before.has(line))
        .map((line) => line.split(':')[0].trim())
        .filter(Boolean);
    if (moved.length) warnings.push(`moved to Extra (not a ${itemType} field): ${moved.join(', ')}`);

    const outCreators = Array.isArray(output.creators) ? output.creators : [];
    const changedRoles = outCreators.filter((creator: any, index: number) =>
        json.creators[index] && creator.creatorType !== json.creators[index].creatorType);
    if (changedRoles.length) warnings.push(`creator roles not valid for ${itemType} were changed to author`);

    const item: ZoteroItemJson = { ...(output as ZoteroItemJson) };
    if (notes.length) item.notes = notes;
    return { ok: true, item, warnings };
}
