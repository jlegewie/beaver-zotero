/**
 * Regression test: reader context (current file + text selection) must keep
 * flowing to every Beaver surface, not just the main-window pane.
 *
 * `useReaderTabSelection` writes `currentReaderAttachmentAtom` /
 * `readerTextSelectionAtom` in the shared store, and clears both when it
 * unmounts. Mounting it from a sidebar component therefore ties reader
 * tracking to that pane's lifetime: hiding the main-window pane silently
 * stopped the separate Beaver window from ever seeing the current file or
 * selection. It belongs in the window-independent `GlobalContextInitializer`,
 * gated on Beaver being visible in *either* surface.
 *
 * These are source-level assertions because the hook needs a live Zotero
 * (readers, tabs, notifier) that unit tests can't stand up.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (relativePath: string) =>
    readFileSync(resolve(__dirname, '../../../', relativePath), 'utf8');

describe('reader context tracking mount point', () => {
    it('is mounted from the window-independent global initializer', () => {
        const index = read('react/index.tsx');
        expect(index).toContain("from './hooks/useReaderTabSelection'");
        expect(index).toContain('useReaderTabSelection();');
    });

    it('is not mounted from a sidebar component', () => {
        for (const component of [
            'react/components/ReaderSidebar.tsx',
            'react/components/LibrarySidebar.tsx',
            'react/components/WindowSidebar.tsx',
            'react/components/Sidebar.tsx',
        ]) {
            expect(read(component)).not.toMatch(/useReaderTabSelection\s*\(/);
        }
    });

    it('tracks while Beaver is visible in either surface', () => {
        const hook = read('react/hooks/useReaderTabSelection.ts');
        expect(hook).toContain('isSidebarVisibleAtom');
        expect(hook).toContain('isBeaverWindowOpenAtom');
        expect(hook).toContain('if (!isBeaverVisible) return;');
    });

    it('publishes the separate window as open while it is mounted', () => {
        const windowSidebar = read('react/components/WindowSidebar.tsx');
        expect(windowSidebar).toContain('isBeaverWindowOpenAtom');
        expect(windowSidebar).toContain('setIsBeaverWindowOpen(true)');
        expect(windowSidebar).toContain('setIsBeaverWindowOpen(false)');
    });

    it('reconnects a surviving separate window when a new main-window bundle loads', () => {
        const uiFactory = read('src/ui/ui.ts');
        const lifecycle = read('src/hooks.ts');
        const separateWindow = read('addon/content/beaverWindow.js');

        expect(uiFactory).toContain('this.reconnectAuxiliaryWindows(win)');
        expect(uiFactory).toContain('reconnect(win.BeaverReact)');
        expect(uiFactory).toContain('liveBeaverReactInstances.includes(currentInstance)');
        expect(lifecycle).toContain('(win as any).BeaverReact');
        expect(separateWindow).toContain('window.reconnectToBeaverReact = reconnectToBeaverReact');
        expect(separateWindow).toContain('window.getBeaverReactInstance = () => BeaverReact');
        expect(separateWindow).toContain('if (BeaverReact === nextBeaverReact)');
        expect(separateWindow).toContain('BeaverReact.unmountFromElement(container)');
        expect(separateWindow).toContain('BeaverReact.renderWindowSidebar(container)');
    });

    it('preserves the active preferences tab during a real bundle handoff', () => {
        const preferencesWindow = read('addon/content/beaverPreferences.js');
        const preferencesComponent = read('react/components/PreferencesWindow.tsx');

        expect(preferencesWindow).toContain('Zotero.__beaverGetPreferencesTab()');
        expect(preferencesWindow).toContain('initialActionsCategoryFilter: null');
        expect(preferencesWindow).toContain('initialActionId: null');
        expect(preferencesComponent).toContain('__beaverGetPreferencesTab = () => activeTabRef.current');
    });
});
