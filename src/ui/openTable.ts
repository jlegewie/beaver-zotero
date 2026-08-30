/**
 * One way to put a stored table on screen.
 *
 * A table can be shown in two places — a temporary Zotero tab holding the
 * rendered document ({@link openTableTab}), or Zotero's own snapshot reader,
 * which `readerTableView.ts` enhances into the same interactive surface. Both
 * existed before this module; what did not exist was a single function that
 * picks between them, so the double-click guard, the dev endpoints and a later
 * item-pane button all reach the same behaviour instead of each re-deciding.
 *
 * Two rules shape the whole file:
 *
 * 1. **Nothing throws.** Every caller is a UI path that must degrade — a
 *    double-click that raises is a dead double-click. Failures come back as
 *    `{ error }`.
 * 2. **A target that cannot open falls back to the other one**, and the result
 *    says which one actually opened. Refusing to show a table because one of
 *    two surfaces is unavailable would be worse than showing it in the other.
 *
 * This module is compiled into the **esbuild** bundle (`src/hooks.ts` reaches
 * it through the double-click guard), so it may not import `react/*` or
 * anything that reaches it. That is why the spec is read through
 * `tableItemIdentity.readTable` — the same function `tableStore` re-exports as
 * its read API — rather than through `tableStore.ts`, which imports the
 * library-exclusion check and with it the whole React graph.
 *
 * Opening is not gated on library exclusion. Exclusion governs writes, indexing
 * and what leaves the machine; a table already in the user's library is theirs
 * to look at.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../utils/prefs';
import {
    readTable,
    resolveTableItem,
    type TableRef,
} from '../services/artifacts/tableItemIdentity';
import { canOpenTableTab, openTableTab } from './tableTab';

/** The two surfaces a stored table can be shown on. */
export type TableTarget = 'tab' | 'reader';

export interface OpenTableOptions {
    /** Overrides the `tables.openIn` preference for this call. */
    where?: TableTarget;
    win?: Window;
}

export type OpenTableOutcome = { opened: TableTarget } | { error: string };

/** Preference naming the default surface. */
const OPEN_IN_PREF = 'tables.openIn';

/** The other one, for the fallback. */
function otherTarget(target: TableTarget): TableTarget {
    return target === 'tab' ? 'reader' : 'tab';
}

/**
 * The surface to try first: an explicit choice, else the preference, else the
 * tab.
 *
 * An unrecognised preference value resolves to `'tab'` rather than failing —
 * a preference nobody can see is a bad reason to refuse to open a table.
 */
export function resolveTableTarget(where?: TableTarget): TableTarget {
    if (where === 'tab' || where === 'reader') return where;
    let stored: unknown;
    try {
        stored = getPref(OPEN_IN_PREF);
    } catch {
        return 'tab';
    }
    return stored === 'reader' ? 'reader' : 'tab';
}

/**
 * Whether any table surface is available in this window.
 *
 * Synchronous, because the double-click guard has to decide before Zotero's
 * default action would have run — so this answers only what can be answered
 * without touching the disk: that a surface exists at all, not that this
 * particular table will open on it.
 */
export function canOpenTable(win: Window = Zotero.getMainWindow()): boolean {
    if (canOpenTableTab(win)) return true;
    return typeof (Zotero.Reader as any)?.open === 'function';
}

/** A target that did not come up, and why — so the fallback can say so. */
type Attempt = { ok: true } | { ok: false; reason: string };

/**
 * Renders the current spec into a Zotero tab.
 *
 * The tab id is derived from the ref, so opening the same table twice
 * re-renders its tab rather than stacking duplicates of it.
 */
async function openInTab(ref: TableRef, win: Window): Promise<Attempt> {
    if (!canOpenTableTab(win)) {
        return { ok: false, reason: 'this Zotero build has no tab API (Zotero_Tabs)' };
    }
    const { spec } = await readTable(ref);
    const tabId = openTableTab(spec, {
        win,
        tabId: `beaver-table-${ref.libraryID}-${ref.key}`,
    });
    if (!tabId) return { ok: false, reason: 'the table tab could not be added' };
    return { ok: true };
}

/**
 * Opens the item in Zotero's reader, which `readerTableView.ts` then enhances.
 *
 * The file is checked first: the reader on a snapshot with no file on disk is
 * an error dialog, which the tab — rendering from the spec — does not need.
 */
async function openInReader(ref: TableRef): Promise<Attempt> {
    const item = await resolveTableItem(ref);
    const path = await item.getFilePathAsync();
    if (!path) return { ok: false, reason: 'the table has no file on disk' };
    if (typeof (Zotero.Reader as any)?.open !== 'function') {
        return { ok: false, reason: 'this Zotero build has no reader API' };
    }
    await (Zotero.Reader as any).open(item.id);
    return { ok: true };
}

function attempt(
    target: TableTarget,
    ref: TableRef,
    win: Window
): Promise<Attempt> {
    return target === 'tab' ? openInTab(ref, win) : openInReader(ref);
}

/**
 * Shows a stored table, on the requested surface or the other one.
 *
 * Returns which surface opened, or a single message naming both refusals.
 * Never throws: a thrown error from either attempt is folded into that message.
 */
export async function openTable(
    ref: TableRef,
    options: OpenTableOptions = {}
): Promise<OpenTableOutcome> {
    let win: Window;
    try {
        win = options.win ?? Zotero.getMainWindow();
    } catch (error) {
        return { error: `No Zotero window to open a table in: ${String(error)}` };
    }
    if (!win) return { error: 'No Zotero window to open a table in.' };

    const first = resolveTableTarget(options.where);
    const second = otherTarget(first);

    const reasons: string[] = [];
    for (const target of [first, second]) {
        let outcome: Attempt;
        try {
            outcome = await attempt(target, ref, win);
        } catch (error) {
            outcome = { ok: false, reason: String((error as Error)?.message ?? error) };
        }
        if (outcome.ok) {
            if (target !== first) {
                logger(
                    `openTable: ${first} unavailable for ${ref.key} (${reasons[0]}); opened in ${target}`,
                    2
                );
            }
            return { opened: target };
        }
        reasons.push(`${target}: ${outcome.reason}`);
    }

    return {
        error: `Could not open table ${ref.key} — ${reasons.join('; ')}.`,
    };
}
