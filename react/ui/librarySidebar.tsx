import React from 'react';
import LibrarySidebar from '../components/LibrarySidebar';
import { activeItemPane, createSidebarMount, placeLibraryMount, sidebarMountId } from '../../src/ui/libraryPane';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';
import { mountSurface } from './surfaceRoots';

/**
 * The library sidebar's mount point. Held by reference: when a Zotero 11
 * library view closes with the sidebar inside, the mount leaves the document
 * with it, and the next library view adopts it with its React tree intact.
 * Each window registration loads a fresh bundle, so this never outlives its
 * renderer.
 */
let libraryMount: Element | null = null;

/**
 * Keep a main window's library sidebar in the item pane of its active library
 * view (see `src/ui/libraryPane.ts`), creating the sidebar the first time the
 * window has one. A no-op for the separate Beaver window, whose context
 * window belongs to another renderer.
 *
 * @returns Whether the sidebar is in the active library view.
 */
export function syncLibrarySidebar(): boolean {
    const runtime = tryGetWindowRuntime();
    if (!runtime || runtime.kind !== 'main') return false;
    const win = runtime.hostWindow;
    if (win.closed) return false;

    libraryMount ??= win.document.getElementById(sidebarMountId('library'));
    if (libraryMount) return placeLibraryMount(win, libraryMount) !== null;

    const pane = activeItemPane(win);
    if (!pane) return false;
    const { mountPoint, reactContainer } = createSidebarMount(win.document, 'library');
    pane.appendChild(mountPoint);
    libraryMount = mountPoint;
    mountSurface(reactContainer, <LibrarySidebar />);
    return true;
}
