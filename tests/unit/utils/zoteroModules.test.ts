/**
 * Zotero 8+ ships its internal modules as ES modules; Zotero 7 ships the same
 * modules as JSMs at different URLs, and has no `.mjs` files.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importZoteroModule, ZOTERO_MODULES } from '../../../src/utils/zoteroModules';

afterEach(() => {
    delete (globalThis as any).ChromeUtils;
});

describe('importZoteroModule', () => {
    it('uses the ES module and never touches ChromeUtils.import when it loads (Zotero 8+)', () => {
        const jsm = vi.fn();
        (globalThis as any).ChromeUtils = { importESModule: vi.fn(() => ({ EPUB: 'esm' })), import: jsm };
        expect(importZoteroModule(ZOTERO_MODULES.epub)).toEqual({ EPUB: 'esm' });
        expect(jsm).not.toHaveBeenCalled();
    });

    it('falls back to the JSM when the ES module fails to load (Zotero 7)', () => {
        const jsm = vi.fn(() => ({ EPUB: 'jsm' }));
        (globalThis as any).ChromeUtils = {
            importESModule: vi.fn((url: string) => { throw new Error(`Failed to load ${url}`); }),
            import: jsm,
        };
        expect(importZoteroModule(ZOTERO_MODULES.epub)).toEqual({ EPUB: 'jsm' });
        expect(jsm).toHaveBeenCalledWith('chrome://zotero/content/EPUB.jsm');
    });

    it('rethrows the ES module error when ChromeUtils.import does not exist (Zotero 11)', () => {
        const esmError = new Error('Failed to load chrome://zotero/content/EPUB.mjs');
        (globalThis as any).ChromeUtils = { importESModule: vi.fn(() => { throw esmError; }) };
        expect(() => importZoteroModule(ZOTERO_MODULES.epub)).toThrow(esmError);
    });

    it('rethrows the ES module error when the JSM fails too', () => {
        const esmError = new Error('Failed to load chrome://zotero/content/EPUB.mjs');
        (globalThis as any).ChromeUtils = {
            importESModule: vi.fn(() => { throw esmError; }),
            import: vi.fn(() => { throw new Error('jsm missing'); }),
        };
        expect(() => importZoteroModule(ZOTERO_MODULES.epub)).toThrow(esmError);
    });

    it('maps every module to a Zotero 7 URL that differs from its ES module URL', () => {
        for (const urls of Object.values(ZOTERO_MODULES)) {
            expect(urls.esm).toMatch(/\.mjs$/);
            expect(urls.jsm).toMatch(/\.jsm?$/);
            expect(urls.jsm).not.toBe(urls.esm);
        }
    });
});
