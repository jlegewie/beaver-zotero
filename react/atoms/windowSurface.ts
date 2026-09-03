import { atom } from 'jotai';
import type { TableSpec } from '@beaver/agent-core/layouts/table';

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
export type WindowSurface =
    | { kind: 'thread' }
    | {
          kind: 'table';
          variant: 'search' | 'extraction';
          table: TableSpec;
          /** Overrides `TableSpec.title` in the window's own title bar. */
          title?: string;
          subtitle?: string;
      };

/**
 * Lives in the shared store like every other atom, so the main window can set
 * it and the separate window — which reuses the main window's React bundle —
 * renders the result.
 *
 * This is the surface for a table that has no Zotero item behind it, and the
 * one an editing UI belongs on: it renders the real `DataTable`. A *stored*
 * table goes to Zotero's snapshot reader instead (`view/readerTableView.ts`),
 * which can never host an editor — its document is a sandboxed iframe with no
 * scripts. So a future main-window tab for editing is a second reader of this
 * atom rather than another host for the stored document.
 */
export const windowSurfaceAtom = atom<WindowSurface>({ kind: 'thread' });

/** Hands the window back to the thread it normally shows. */
export const showThreadInWindowAtom = atom(null, (_get, set) => {
    set(windowSurfaceAtom, { kind: 'thread' });
});
