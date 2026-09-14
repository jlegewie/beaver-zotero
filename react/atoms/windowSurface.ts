import { atom } from "jotai";
import type { TableSpec } from "@beaver/agent-core/layouts/table";

/**
 * What the separate Beaver window is currently showing.
 *
 * The window has always rendered the thread and nothing else. A table needs the
 * same room and the same React instance, so rather than opening a second kind
 * of window it takes this one over and hands it back when the user is done.
 *
 * `variant` picks the chrome, not the grid: both variants render the same
 * `DataTable`, and differ only in the verbs around it. It is explicit rather
 * than derived from the spec's capabilities, because "which surface is this"
 * is the producer's decision and not something to infer from a flag.
 */
export type WindowSurface = { kind: "thread" } | TableWindowSurface;

export interface TableWindowSurface {
    kind: "table";
    /**
     * Which showing this is. A new id every time the window is asked to show a
     * table, the same id while that table is updated in place — so the view
     * state (sort, filters, hidden columns) resets between tables and only
     * then. A spec cannot carry this itself: an unstored table has only a
     * render-scoped `id`, which two different tables may share. Assigned by
     * {@link showTableInWindowAtom}.
     */
    id: string;
    variant: "search" | "extraction";
    table: TableSpec;
    /** Overrides `TableSpec.title` in the window's own title bar. */
    title?: string;
    subtitle?: string;
}

/** Local standalone presentation state. Cross-window commands deliver plain data. */
export const windowSurfaceAtom = atom<WindowSurface>({ kind: "thread" });

let nextTableSurfaceId = 0;

/**
 * Shows a table in the window. Every call is a new showing with its own id; to
 * update the table already on screen, set `windowSurfaceAtom` with the current
 * surface's id instead.
 */
export const showTableInWindowAtom = atom(
    null,
    (
        _get,
        set,
        surface: Omit<TableWindowSurface, "kind" | "id">,
    ): TableWindowSurface => {
        nextTableSurfaceId += 1;
        const next: TableWindowSurface = {
            kind: "table",
            id: `table-${nextTableSurfaceId}`,
            ...surface,
        };
        set(windowSurfaceAtom, next);
        return next;
    },
);

/** Hands the window back to the thread it normally shows. */
export const showThreadInWindowAtom = atom(null, (_get, set) => {
    set(windowSurfaceAtom, { kind: "thread" });
});
