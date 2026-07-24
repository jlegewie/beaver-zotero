/**
 * Guards the architecture that makes reader context work in the separate
 * Beaver window: tracking is keyed to "any Beaver surface is open", and the
 * hook that does it is mounted globally rather than by one surface.
 *
 * The live suite (`tests/live/beaverWindowContext.live.test.ts`) proves the
 * end-to-end behavior, but it skips whenever Zotero, the profile, or the open
 * tab is unsuitable. These checks always run.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { readFileSync } from 'fs';
import { join } from 'path';

// The atoms module's import chain reaches Supabase at load time.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => false),
    setPref: vi.fn(),
}));

const { isBeaverUIVisibleAtom, isBeaverWindowOpenAtom, isSidebarVisibleAtom } = await import(
    '../../../react/atoms/ui'
);

const repoRoot = join(__dirname, '../../..');
const readSource = (relativePath: string) => readFileSync(join(repoRoot, relativePath), 'utf8');

describe('isBeaverUIVisibleAtom', () => {
    it.each([
        { sidebar: false, window: false, visible: false },
        { sidebar: true, window: false, visible: true },
        { sidebar: false, window: true, visible: true },
        { sidebar: true, window: true, visible: true },
    ])(
        'is $visible with sidebar=$sidebar window=$window',
        ({ sidebar, window: windowOpen, visible }) => {
            const store = createStore();
            store.set(isSidebarVisibleAtom, sidebar);
            store.set(isBeaverWindowOpenAtom, windowOpen);

            expect(store.get(isBeaverUIVisibleAtom)).toBe(visible);
        },
    );
});

describe('reader tab tracking mount point', () => {
    it('is mounted by the global context initializer', () => {
        const source = readSource('react/index.tsx');

        expect(source).toContain('useReaderTabSelection');
        expect(source).toMatch(/useReaderTabSelection\(\)/);
    });

    it('is not mounted by the reader sidebar', () => {
        // Mounting it there ties reader context to the sidebar, which leaves the
        // separate window with no current attachment, page, or text selection.
        const source = readSource('react/components/ReaderSidebar.tsx');

        expect(source).not.toMatch(/useReaderTabSelection\(\)/);
    });
});
