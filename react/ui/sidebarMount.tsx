import React from 'react';
import type { Root } from 'react-dom/client';
import MainSidebar from '../components/MainSidebar';
import { createSidebarMount, isLibraryTabSelected } from '../../src/ui/libraryPane';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';
import { store } from '../store';
import { isSidebarVisibleAtom } from '../atoms/ui';
import { mountSurface } from './surfaceRoots';
import { uiManager } from './UIManager';

/** Each window registration loads a fresh bundle, so this never outlives its window. */
let sidebarRendered = false;

/**
 * Create a main window's sidebar and render it, once per renderer. The UI
 * manager places the element in the pane of the selected tab and moves it on
 * every tab switch, so the one React tree serves library and reader tabs.
 *
 * The element can leave the document while the window still uses it: a Zotero
 * 11 library view that closes with the sidebar inside takes it along. The UI
 * manager holds it by reference and places it again on the next tab switch.
 *
 * @returns The new root, or null for a window without a sidebar (the separate
 *     Beaver window has its own surface) or one that already has it.
 */
export function renderSidebar(): Root | null {
    const runtime = tryGetWindowRuntime();
    if (!runtime || runtime.kind !== 'main' || runtime.status === 'closing') return null;
    const win = runtime.hostWindow;
    if (win.closed || sidebarRendered) return null;
    sidebarRendered = true;

    const { mountPoint, reactContainer } = createSidebarMount(win.document);
    uiManager.setSidebarMount(mountPoint);
    uiManager.updateUI({
        isVisible: store.get(isSidebarVisibleAtom),
        isLibraryTab: isLibraryTabSelected(win),
    });
    return mountSurface(reactContainer, <MainSidebar />);
}
