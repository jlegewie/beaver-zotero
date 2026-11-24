/**
 * Detect tags an action is about to create that differ from a tag the library
 * already has only in form: case, spacing, hyphens/underscores, or a plural
 * ending (`Machine learning` / `machine-learning`, `sandwich panel` /
 * `sandwich panels`). Zotero treats each spelling as its own tag, so a new
 * spelling splits the items a user filters by.
 *
 * Advisory only: the caller reports the matches and never changes or blocks
 * the write. Every query is best-effort.
 */

import { libraryRefForLibraryID } from '../../../utils/libraryIdentity';
import { canonicalTagForm } from './manageTags';

/** A tag an action created next to existing tags of nearly the same name. */
export interface SimilarExistingTag {
    tag: string;
    library_ref: string | null;
    existing: string[];
}

export const MAX_SIMILAR_TAGS_REPORTED = 10;
const MAX_EXISTING_PER_TAG = 3;
// Keeps each IN (...) list well under SQLite's bound-parameter limit.
const NAME_QUERY_CHUNK = 500;

/**
 * The form two tag names share when they differ only in case, spacing,
 * hyphens/underscores, or a plural ending on the last word.
 */
export function similarTagKey(name: string): string {
    const words = canonicalTagForm(name).replace(/[-_\s]+/g, ' ').trim().split(' ');
    const last = words[words.length - 1];
    if (last.length > 3) {
        if (last.endsWith('ies')) {
            words[words.length - 1] = `${last.slice(0, -3)}y`;
        } else if (last.endsWith('s') && !/(ss|us|is)$/.test(last)) {
            words[words.length - 1] = last.slice(0, -1);
        }
    }
    return words.join(' ');
}

/** Which of `names` are on at least one item in the library. */
async function namesInLibrary(libraryID: number, names: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let start = 0; start < names.length; start += NAME_QUERY_CHUNK) {
        const chunk = names.slice(start, start + NAME_QUERY_CHUNK);
        await Zotero.DB.queryAsync(
            'SELECT DISTINCT t.name FROM tags t '
                + 'JOIN itemTags it USING (tagID) '
                + 'JOIN items i USING (itemID) '
                + `WHERE i.libraryID = ? AND t.name IN (${chunk.map(() => '?').join(', ')})`,
            [libraryID, ...chunk],
            { onRow: (row: any) => { found.add(row.getResultByIndex(0) as string); } },
        );
    }
    return found;
}

/**
 * Pre-write snapshot for one library: which of the names to add already
 * exist there, and the library's other spellings of each new one.
 *
 * The exact lookup is indexed and settles the common case (every name already
 * exists) without scanning. Otherwise the global `tags` table is scanned
 * without joins, keeping in memory only the names that share a key with a new
 * one, and those few are then checked against the library.
 */
export async function snapshotSimilarTags(
    libraryID: number,
    names: string[],
): Promise<{ existing: Set<string>; similar: Map<string, string[]> }> {
    const unique = [...new Set(names)];
    const existing = await namesInLibrary(libraryID, unique);
    const similar = new Map<string, string[]>();
    const created = unique.filter(name => !existing.has(name));
    if (created.length === 0) return { existing, similar };

    const createdNames = new Set(created);
    const keys = new Set(created.map(similarTagKey));
    const candidates: string[] = [];
    await Zotero.DB.queryAsync('SELECT name FROM tags', [], {
        onRow: (row: any) => {
            const name = row.getResultByIndex(0) as string;
            if (!createdNames.has(name) && keys.has(similarTagKey(name))) candidates.push(name);
        },
    });
    if (candidates.length === 0) return { existing, similar };

    const inLibrary = await namesInLibrary(libraryID, candidates);
    for (const name of inLibrary) {
        const key = similarTagKey(name);
        similar.set(key, [...(similar.get(key) ?? []), name]);
    }
    return { existing, similar };
}

/**
 * Tags the write created that sit beside existing spellings in their library.
 *
 * `created` maps each library to the tags the write added to its items. A tag
 * counts only when it did not exist in that library before the write. Existing
 * spellings the same call removed are left out: removing one while adding the
 * other is a deliberate replacement.
 */
export function similarExistingTags(
    created: Map<number, Set<string>>,
    snapshots: Map<number, { existing: Set<string>; similar: Map<string, string[]> }>,
    removed: string[],
): SimilarExistingTag[] {
    const removedNames = new Set(removed);
    const report: SimilarExistingTag[] = [];
    for (const [libraryID, tags] of created) {
        const snapshot = snapshots.get(libraryID);
        if (!snapshot) continue;
        for (const tag of tags) {
            if (snapshot.existing.has(tag)) continue;
            const matches = (snapshot.similar.get(similarTagKey(tag)) ?? [])
                .filter(name => name !== tag && !removedNames.has(name));
            if (matches.length === 0) continue;
            report.push({
                tag,
                library_ref: libraryRefForLibraryID(libraryID),
                existing: matches.slice(0, MAX_EXISTING_PER_TAG),
            });
            if (report.length >= MAX_SIMILAR_TAGS_REPORTED) return report;
        }
    }
    return report;
}
