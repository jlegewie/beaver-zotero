/**
 * The .bib file of a LaTeX export, and the citation key of every cited work.
 *
 * Keys are never invented: they are whatever the translator writing the
 * entries uses. With Better BibTeX installed, library items get its keys and
 * its entries; otherwise Zotero's own BibLaTeX/BibTeX translator writes them,
 * and its key (from Extra's `Citation Key:`, the citation key field, or a
 * generated `author_title_year`) is read back from the output. Works without a
 * library item (external references, standalone attachments) are exported
 * from their CSL-JSON as unsaved items, each on its own, and their keys are
 * kept distinct from the rest.
 *
 * Entries leave out the `file` field the translators fill with the paths of
 * local attachments: the .bib file goes wherever the paper goes, where those
 * paths mean nothing and would disclose the user's folders.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { FieldCitationItem } from '@beaver/agent-export/types';

export type BibFormat = 'biblatex' | 'bibtex';

const ZOTERO_TRANSLATORS: Record<BibFormat, string> = {
    biblatex: 'b6e39b57-8942-4d11-8259-342c46ce395f',
    bibtex: '9cb70025-a888-4a29-a210-93ec52da40d4',
};

const BETTER_BIBTEX_TRANSLATORS: Record<BibFormat, string> = {
    biblatex: 'f895aa0d-f28e-47fe-b247-2ea77c6ed583',
    bibtex: 'ca65189f-8815-4afe-8c8b-8c7c15f0edca',
};

/** Marks a .bib file as written by an export, so a later export may replace it. */
export const BIB_FILE_MARKER = '% Exported by Beaver';

export interface BibliographyFile {
    /** Entries of every cited work that got a key. */
    bib: string;
    /** Citation key by processor id (as a string). */
    keys: Record<string, string>;
}

/** An entry's start: `@type{key,` (not `@comment`, `@string`, `@preamble`). */
const ENTRY_PATTERN = /^@(\w+)\s*\{\s*([^,\s]*)\s*,/gm;
const NON_ENTRY_TYPES = new Set(['comment', 'string', 'preamble']);

/** Keys of the entries in translator output, in order. */
export function entryKeys(bib: string): string[] {
    return [...bib.matchAll(ENTRY_PATTERN)]
        .filter(match => !NON_ENTRY_TYPES.has(match[1].toLowerCase()))
        .map(match => match[2]);
}

/** A key not in `used`: the key itself, else with the first free `-n` suffix (as the translators do). */
export function distinctKey(key: string, used: Set<string>): string {
    if (!used.has(key)) return key;
    let suffix = 1;
    while (used.has(`${key}-${suffix}`)) suffix += 1;
    return `${key}-${suffix}`;
}

/** Output of an export translator over `items`. */
async function translate(items: Zotero.Item[], translatorID: string): Promise<string> {
    const translation = new (Zotero as any).Translate.Export();
    // `setItems` sorts the array it is given and consumes it.
    translation.setItems(items.slice());
    translation.setTranslator(translatorID);
    translation.setDisplayOptions({
        exportCharset: 'UTF-8',
        exportNotes: false,
        exportFileData: false,
        useJournalAbbreviation: false,
    });
    let output: string | null = null;
    translation.setHandler('done', (translate: { string: string }, success: boolean) => {
        if (success) output = translate.string;
    });
    await translation.translate();
    if (output === null) throw new Error(`Export translator ${translatorID} failed`);
    return output;
}

/** Better BibTeX's keys and entries for library items, or null when it is absent or they do not match. */
async function betterBibTeXEntries(items: Zotero.Item[], format: BibFormat): Promise<{ bib: string; keys: Map<number, string> } | null> {
    const betterBibTeX = (Zotero as any).BetterBibTeX;
    if (!betterBibTeX?.KeyManager?.get) return null;
    try {
        await betterBibTeX.ready;
        const keys = new Map<number, string>();
        for (const item of items) {
            const key = betterBibTeX.KeyManager.get(item.id)?.citationKey;
            if (typeof key !== 'string' || !key) return null;
            keys.set(item.id, key);
        }
        // Keys are unique per library; items from two libraries may share one.
        if (new Set(keys.values()).size !== keys.size) return null;
        const bib = await translate(items, BETTER_BIBTEX_TRANSLATORS[format]);
        const written = new Set(entryKeys(bib));
        if (![...keys.values()].every(key => written.has(key))) {
            logger('bibliographyFile: Better BibTeX entries do not match its keys; using Zotero\'s translator', 2);
            return null;
        }
        return { bib, keys };
    } catch (error) {
        logger(`bibliographyFile: Better BibTeX export failed, using Zotero's translator: ${error}`, 2);
        return null;
    }
}

/** Zotero's translator over library items: one batch, keys read back by position (entries come in item id order). */
async function zoteroEntries(items: Zotero.Item[], format: BibFormat): Promise<{ bib: string; keys: Map<number, string> }> {
    const translatorID = ZOTERO_TRANSLATORS[format];
    const bib = await translate(items, translatorID);
    const keys = entryKeys(bib);
    const sorted = items.slice().sort((a, b) => a.id - b.id);
    // An explicit key (Extra's `Citation Key:`, the citation key field) is
    // written as is, so two items can share one; those are disambiguated below.
    if (keys.length === sorted.length && keys.every(Boolean) && new Set(keys).size === keys.length) {
        return { bib, keys: new Map(sorted.map((item, index) => [item.id, keys[index]])) };
    }
    // Entries and items do not line up, or keys repeat: export each item on its own.
    logger(`bibliographyFile: ${keys.length} entries (${new Set(keys).size} keys) for ${sorted.length} items; exporting one by one`, 2);
    const entries: string[] = [];
    const byItem = new Map<number, string>();
    const used = new Set<string>();
    for (const item of sorted) {
        const entry = await translate([item], translatorID);
        const [key] = entryKeys(entry);
        if (!key) continue;
        const distinct = distinctKey(key, used);
        used.add(distinct);
        byItem.set(item.id, distinct);
        entries.push(distinct === key ? entry : renameEntry(entry, key, distinct));
    }
    return { bib: entries.join('\n'), keys: byItem };
}

/** `bib` without its `file = {…}` fields (local attachment paths). */
export function withoutFileFields(bib: string): string {
    const field = /^[ \t]*file\s*=\s*\{/gim;
    let out = '';
    let cursor = 0;
    for (let match = field.exec(bib); match; match = field.exec(bib)) {
        // The value ends at its matching brace (values nest braces; `\{` is escaped).
        let depth = 0;
        let end = match.index + match[0].length - 1;
        for (; end < bib.length; end++) {
            if (bib[end] === '\\') end += 1;
            else if (bib[end] === '{') depth += 1;
            else if (bib[end] === '}' && --depth === 0) break;
        }
        if (end >= bib.length) break;
        // The field's comma and line go with it.
        const rest = /^[ \t]*,?[ \t]*\r?\n?/.exec(bib.slice(end + 1))?.[0] ?? '';
        out += bib.slice(cursor, match.index);
        cursor = end + 1 + rest.length;
        field.lastIndex = cursor;
    }
    return out + bib.slice(cursor);
}

/** Change the key of the (single) entry in `entry`. */
function renameEntry(entry: string, key: string, newKey: string): string {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return entry.replace(new RegExp(`^(@\\w+\\s*\\{\\s*)${escaped}(\\s*,)`, 'm'), `$1${newKey}$2`);
}

/** A temporary, unsaved item from CSL-JSON, for the translator. */
function itemFromCsl(csl: Record<string, unknown>): Zotero.Item {
    const item = new Zotero.Item();
    item.libraryID = Zotero.Libraries.userLibraryID;
    (Zotero.Utilities as any).Item.itemFromCSLJSON(item, JSON.parse(JSON.stringify(csl)));
    return item;
}

/**
 * Write .bib entries for the cited works of an export (`items`: the cluster
 * items, repeats allowed) and return each work's key.
 */
export async function buildBibliographyFile(items: FieldCitationItem[], format: BibFormat): Promise<BibliographyFile> {
    const works = new Map<string, FieldCitationItem>();
    for (const item of items) {
        if (!works.has(String(item.id))) works.set(String(item.id), item);
    }

    const libraryItems: Zotero.Item[] = [];
    const embedded: FieldCitationItem[] = [];
    for (const work of works.values()) {
        const item = typeof work.id === 'number' ? await Zotero.Items.getAsync(work.id) : null;
        // The translators write entries for regular items only.
        if (item && (item as Zotero.Item).isRegularItem()) libraryItems.push(item as Zotero.Item);
        else embedded.push(work);
    }

    const keys: Record<string, string> = {};
    const parts: string[] = [];
    const used = new Set<string>();
    if (libraryItems.length > 0) {
        const library = await betterBibTeXEntries(libraryItems, format) ?? await zoteroEntries(libraryItems, format);
        parts.push(library.bib.trim());
        for (const [id, key] of library.keys) {
            keys[String(id)] = key;
            used.add(key);
        }
    }
    // Better BibTeX writes no key for an unsaved item, so these always use Zotero's translator.
    for (const work of embedded) {
        if (Object.keys(work.itemData).length === 0) continue;
        try {
            const entry = await translate([itemFromCsl(work.itemData)], ZOTERO_TRANSLATORS[format]);
            const [key] = entryKeys(entry);
            if (!key) continue;
            const distinct = distinctKey(key, used);
            used.add(distinct);
            keys[String(work.id)] = distinct;
            parts.push((distinct === key ? entry : renameEntry(entry, key, distinct)).trim());
        } catch (error) {
            logger(`bibliographyFile: could not write an entry for ${work.id}: ${error}`, 2);
        }
    }
    return { bib: withoutFileFields(parts.filter(Boolean).join('\n\n')), keys };
}
