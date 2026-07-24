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

    it('only stages annotation adds from the active reader attachment', () => {
        const hook = read('react/hooks/useReaderTabSelection.ts');
        expect(hook).toContain('const activeReader = getCurrentReader(mainWindow);');
        expect(hook).toContain('activeReader.itemID !== currentReaderIdRef.current');
        expect(hook).toContain('item.parentItemID !== activeReader.itemID');
    });

    it('clears reader context before awaiting annotation cleanup', () => {
        const hook = read('react/hooks/useReaderTabSelection.ts');
        const nonReaderBranch = hook.slice(
            hook.indexOf('// Tab switched to something other than a reader'),
            hook.indexOf('// Annotation events'),
        );
        const clearIndex = nonReaderBranch.indexOf(
            'const { readerToClean } = clearReaderContext();',
        );
        const cleanupIndex = nonReaderBranch.indexOf(
            'await BeaverTemporaryAnnotations.cleanupAll(readerToClean as ZoteroReader);',
        );

        expect(clearIndex).toBeGreaterThan(-1);
        expect(cleanupIndex).toBeGreaterThan(clearIndex);

        const clearReaderContext = hook.slice(
            hook.indexOf('const clearReaderContext = useCallback'),
            hook.indexOf('// Function to poll for reader._internalReader readiness'),
        );
        expect(clearReaderContext).toContain('currentReaderIdRef.current = null;');
        expect(clearReaderContext).toContain('currentReaderRef.current = null;');
        expect(clearReaderContext).toContain('setReaderTextSelection(null);');
        expect(clearReaderContext).toContain('clearReaderAttachment();');
    });

    it('does not set up a reader from a stale asynchronous tab transition', () => {
        const hook = read('react/hooks/useReaderTabSelection.ts');
        const readerTransition = hook.slice(
            hook.indexOf('if (newReader && newReader.itemID !== currentReaderIdRef.current)'),
            hook.indexOf('} else if (!newReader)'),
        );
        const cleanupIndex = readerTransition.indexOf(
            'await BeaverTemporaryAnnotations.cleanupAll(readerToClean as ZoteroReader);',
        );
        const generationCheckIndex = readerTransition.indexOf(
            'generation !== readerTransitionGenerationRef.current',
        );
        const activeReaderCheckIndex = readerTransition.indexOf(
            'activeReader?.itemID !== newReader.itemID',
        );
        const setupIndex = readerTransition.indexOf('await setupReader(newReader, generation);');

        expect(cleanupIndex).toBeGreaterThan(-1);
        expect(generationCheckIndex).toBeGreaterThan(cleanupIndex);
        expect(activeReaderCheckIndex).toBeGreaterThan(cleanupIndex);
        expect(setupIndex).toBeGreaterThan(activeReaderCheckIndex);
    });

    it('removes the reader validation popup when clearing the attachment', () => {
        const atoms = read('react/atoms/messageComposition.ts');
        const clearReaderAttachment = atoms.slice(
            atoms.indexOf('export const clearReaderAttachmentAtom'),
            atoms.indexOf('/**\n* Update current reader attachment'),
        );

        expect(clearReaderAttachment).toContain(
            'const currentReaderAttachmentKey = get(currentReaderAttachmentKeyAtom);',
        );
        expect(clearReaderAttachment).toContain(
            'set(removePopupMessageAtom, currentReaderAttachmentKey);',
        );
        expect(clearReaderAttachment).toContain('set(currentReaderAttachmentAtom, null);');
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
