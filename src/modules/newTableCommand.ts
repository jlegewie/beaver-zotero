/**
 * New tables from Zotero's own menus: an empty one from the New Note menu,
 * and one holding the items of the collections or saved searches the user
 * right-clicked. The table is created in the plugin realm and opened in a
 * Beaver tab.
 *
 * Lives in the esbuild bundle — must NOT import from react/store or Jotai.
 */

import { MAX_ROWS, type LibraryScope, type SourceEntry } from '@beaver/agent-core/layouts/table';
import { buildTable } from '@beaver/agent-core/layouts/tableEdit';
import { logger } from '@beaver/agent-core/platform/logger';
import { resolveSources } from '../services/artifacts/tableSources';
import { createTable } from '../services/artifacts/tableStore';
import { resolveTableLibrary } from '../services/artifacts/tableItem';
import { openTable } from '../ui/openTable';
import { libraryRefForLibraryID } from '../utils/libraryIdentity';

/** What a new table starts from. */
export interface NewTableTarget {
    libraryID: number;
    /** File the table in this collection, as a new note is filed. */
    collectionID?: number;
    /** Collections or saved searches whose items become the rows. */
    scopes: LibraryScope[];
    title: string;
}

/**
 * Whether a new table can be filed in the library: a personal or group
 * library the user can edit and has not excluded in Beaver preferences.
 */
export function canCreateTableIn(libraryID: number): boolean {
    return 'libraryID' in resolveTableLibrary(libraryID);
}

/**
 * The scope of a collection or saved search in the collections tree, or null
 * for any other row (a library, a special view such as Unfiled Items).
 */
export function newTableScope(row: any): { libraryID: number; scope: LibraryScope } | null {
    try {
        const kind = row?.isCollection?.() ? 'collection' : row?.isSearch?.() ? 'saved_search' : null;
        const ref = row?.ref;
        if (!kind || !ref?.key || typeof ref.libraryID !== 'number') return null;
        const library_ref = libraryRefForLibraryID(ref.libraryID);
        if (!library_ref) return null;
        return { libraryID: ref.libraryID, scope: { kind, library_ref, key: ref.key, name: ref.name } };
    } catch {
        return null;
    }
}

/** "Cash transfers", or "Cash transfers and 2 more" for several sources. */
export function newTableTitle(scopes: readonly LibraryScope[]): string {
    const first = scopes[0]?.name;
    if (!first) return 'New table';
    return scopes.length === 1 ? first : `${first} and ${scopes.length - 1} more`;
}

/** Creates the table and opens it; a refusal or failure is shown in an alert. */
export async function createAndOpenTable(win: Window, target: NewTableTarget): Promise<void> {
    try {
        const sources: SourceEntry[] = target.scopes.map((scope, index) => ({ id: `s${index + 1}`, type: 'library', scope }));
        const resolved = await resolveSources(sources);
        const built = buildTable(
            { id: `t${Date.now().toString(36)}`, title: target.title },
            resolved,
            new Date().toISOString().slice(0, 10),
            MAX_ROWS,
            // An empty collection makes an empty table that keeps it as a source.
            { allowEmpty: true },
        );
        if (!built.ok) {
            const large = resolved.find((source) => source.truncated) ?? null;
            alert(
                win,
                built.code === 'too_large'
                    ? `A table holds at most ${MAX_ROWS} items${large ? `, and “${large.entry.scope?.name ?? 'this source'}” has ${large.total}` : ''}. Start from a smaller collection or search, or create an empty table and add items to it.`
                    : (resolved.find((source) => source.error)?.error ?? built.message),
            );
            return;
        }
        const created = await createTable({
            spec: built.spec,
            libraryID: target.libraryID,
            collectionID: target.collectionID ?? null,
            title: target.title,
            actor: 'user',
        });
        const opened = await openTable({ libraryID: created.libraryID, key: created.key }, { window: win });
        if ('error' in opened) alert(win, opened.error);
    } catch (error) {
        logger(`newTableCommand: could not create a table: ${String((error as Error)?.message ?? error)}`, 1);
        alert(win, `Beaver couldn't create the table. ${String((error as Error)?.message ?? error)}`);
    }
}

function alert(win: Window, message: string): void {
    Services.prompt.alert((win.closed ? null : win) as any, 'Beaver', message);
}
