import { describe, expect, it } from 'vitest';
import {
    baseCitationKey,
    citationIndexCandidateIdsForLocator,
    externalCompatKey,
    getPageLocator,
    getRequestedRef,
    getResolvedRef,
    locatorFromLegacyPage,
    normalizeCitationTag,
    parseLoc,
    parseZoteroId,
    requestedCitationKey,
    parseRawCitationAttributes,
} from '../../../react/utils/citationGrammar';

describe('citationGrammar', () => {
    it('parses registered locator prefixes and ranges', () => {
        expect(parseLoc('p10')).toEqual({ kind: 'paragraph', value: '10', raw: 'p10' });
        expect(parseLoc('page12')).toEqual({ kind: 'page', value: '12', raw: 'page12' });
        expect(parseLoc('pageiv')).toEqual({ kind: 'page', value: 'iv', raw: 'pageiv' });
        expect(parseLoc('s343')).toEqual({ kind: 'sentence', value: '343', raw: 's343' });
        expect(parseLoc('s0-s8')).toEqual({ kind: 'sentence', value: '0-8', raw: 's0-s8' });
        expect(parseLoc('l34')).toEqual({ kind: 'line', value: '34', raw: 'l34' });
        expect(parseLoc('l34-l38')).toEqual({ kind: 'line', value: '34-38', raw: 'l34-l38' });
        expect(parseLoc('paragraph12')).toEqual({ kind: 'paragraph', value: '12', raw: 'paragraph12' });
        expect(parseLoc('heading3')).toEqual({ kind: 'heading', value: '3', raw: 'heading3' });
        expect(parseLoc('list8')).toEqual({ kind: 'list', value: '8', raw: 'list8' });
        expect(parseLoc('list5')).toEqual({ kind: 'list', value: '5', raw: 'list5' });
        expect(parseLoc('caption12')).toEqual({ kind: 'caption', value: '12', raw: 'caption12' });
        expect(parseLoc('footnote4')).toEqual({ kind: 'footnote', value: '4', raw: 'footnote4' });
        expect(parseLoc('margin6')).toEqual({ kind: 'margin', value: '6', raw: 'margin6' });
        expect(parseLoc('fig2')).toEqual({ kind: 'figure', value: '2', raw: 'fig2' });
        expect(parseLoc('eq4')).toEqual({ kind: 'equation', value: '4', raw: 'eq4' });
        expect(parseLoc('table3')).toEqual({ kind: 'table', value: '3', raw: 'table3' });
        expect(parseLoc('tab3')).toEqual({ kind: 'table', value: '3', raw: 'tab3' });
        expect(parseLoc('p10-p12')).toEqual({ kind: 'paragraph', value: '10-12', raw: 'p10-p12' });
    });

    it('maps accepted locator aliases to structured citation index ids', () => {
        expect(citationIndexCandidateIdsForLocator(parseLoc('paragraph12')!)).toEqual(['p12']);
        expect(citationIndexCandidateIdsForLocator(parseLoc('l34-l38')!)).toEqual(['l34', 'l38']);
        expect(citationIndexCandidateIdsForLocator(parseLoc('tab3')!)).toEqual(['table3']);
        expect(citationIndexCandidateIdsForLocator(parseLoc('p10-p12')!)).toEqual(['p10', 'p12']);
        expect(citationIndexCandidateIdsForLocator(parseLoc('heading3')!)).toEqual(['heading3']);
    });

    it('keeps unknown and legacy page locators stable', () => {
        expect(parseLoc('10-12')).toEqual({ kind: 'unknown', value: '10-12', raw: '10-12' });
        expect(parseLoc('paragraph')).toEqual({ kind: 'unknown', value: 'paragraph', raw: 'paragraph' });
        expect(parseLoc('paragraphIntro')).toEqual({ kind: 'unknown', value: 'paragraphIntro', raw: 'paragraphIntro' });
        expect(locatorFromLegacyPage('222, 237-238')).toEqual({
            kind: 'page',
            value: '222, 237-238',
            raw: '222, 237-238',
        });
    });

    it('strictly parses Zotero IDs', () => {
        expect(parseZoteroId('1-ABC-DEF')).toEqual({ library_id: 1, zotero_key: 'ABC-DEF' });
        expect(parseZoteroId('user-content-2-KEY')).toEqual({ library_id: 2, zotero_key: 'KEY' });
        expect(parseZoteroId('0-ABC')).toBeNull();
        expect(parseZoteroId('ABC')).toBeNull();
        expect(parseZoteroId('1-')).toBeNull();
    });

    it('normalizes new, legacy, external, and invalid citation tags', () => {
        expect(normalizeCitationTag({ id: '1-ABC', loc: 'page3' })).toMatchObject({
            ok: true,
            ref: { kind: 'zotero', library_id: 1, zotero_key: 'ABC', loc: { kind: 'page', value: '3', raw: 'page3' } },
        });
        expect(normalizeCitationTag({ att_id: '1-ATT', sid: 's0-s8' })).toMatchObject({
            ok: true,
            ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATT', loc: { kind: 'sentence', value: '0-8', raw: 's0-s8' } },
        });
        expect(normalizeCitationTag({ att_id: '1-ATT', sid: 'heading3' })).toMatchObject({
            ok: true,
            ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATT', loc: { kind: 'heading', value: '3', raw: 'heading3' } },
        });
        expect(normalizeCitationTag({ att_id: '1-ATT', loc: 'p12' })).toMatchObject({
            ok: true,
            ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATT', loc: { kind: 'paragraph', value: '12', raw: 'p12' } },
        });
        expect(normalizeCitationTag({ item_id: '1-ABC', page: '10-12' })).toMatchObject({
            ok: true,
            ref: { kind: 'zotero', loc: { kind: 'page', value: '10-12', raw: '10-12' } },
        });
        expect(normalizeCitationTag({ external_id: 'W12345' })).toMatchObject({
            ok: true,
            ref: { kind: 'external', external_id: 'W12345' },
        });
        expect(normalizeCitationTag({})).toMatchObject({ ok: false, reason: 'missing_identity' });
        expect(normalizeCitationTag({ id: 'bad', external_id: 'W1' })).toMatchObject({ ok: false, reason: 'conflicting_identity' });
        expect(normalizeCitationTag({ id: 'bad' })).toMatchObject({ ok: false, reason: 'invalid_zotero_id', rawIdentity: 'bad' });
        expect(normalizeCitationTag({ external_id: '   ' })).toMatchObject({ ok: false, reason: 'invalid_external_id' });
    });

    it('parses escaped quote citation attributes', () => {
        expect(parseRawCitationAttributes('att_id=\\"1-NLNMPWNQ\\" sid=\\"heading3\\"')).toEqual({
            att_id: '1-NLNMPWNQ',
            sid: 'heading3',
        });
    });

    it('builds requested, base, and external compatibility keys', () => {
        const zotero = normalizeCitationTag({ id: '1-ABC', loc: 'page3' });
        expect(zotero.ok && requestedCitationKey(zotero.ref)).toBe('zotero:1-ABC:page3');
        expect(zotero.ok && baseCitationKey(zotero.ref)).toBe('zotero:1-ABC');
        expect(zotero.ok && getPageLocator(zotero.ref)).toBe('3');

        expect(externalCompatKey('W1')).toBe('external:W1');
        expect(requestedCitationKey({ kind: 'external', external_id: 'W1', source: 'openalex' })).toBe('external:openalex:W1');
    });

    it('prefers backend refs and back-fills missing loc from raw tags', () => {
        const requested = getRequestedRef({
            requested_ref: { kind: 'zotero', library_id: 1, zotero_key: 'REQUESTED' },
            raw_tag: '<citation item_id="1-ORIGINAL" page="4"/>',
        });
        expect(requested).toEqual({
            kind: 'zotero',
            library_id: 1,
            zotero_key: 'REQUESTED',
            loc: { kind: 'page', value: '4', raw: '4' },
        });

        const resolved = getResolvedRef({
            resolved_ref: { kind: 'external', external_id: 'W123', source: 'openalex' },
            raw_tag: '<citation external_id="W123" loc="page3"/>',
        });
        expect(resolved).toEqual({
            kind: 'external',
            external_id: 'W123',
            source: 'openalex',
            loc: { kind: 'page', value: '3', raw: 'page3' },
        });

        const resolvedWithRequestedLoc = getResolvedRef({
            requested_ref: {
                kind: 'zotero',
                library_id: 1,
                zotero_key: 'ATTACHMENT',
                loc: { kind: 'page', value: '4', raw: 'page4' },
            },
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'PARENT' },
        });
        expect(resolvedWithRequestedLoc).toEqual({
            kind: 'zotero',
            library_id: 1,
            zotero_key: 'PARENT',
            loc: { kind: 'page', value: '4', raw: 'page4' },
        });
    });
});

describe('external file citations (ext-<KEY>)', () => {
    it('parses ext ids under the generic id attribute and normalizes the key', () => {
        for (const raw of ['ext-AB12CD34', 'ext-ab12cd34', 'EXT-ab12cd34']) {
            const normalized = normalizeCitationTag({ id: raw, loc: 'page2' });
            expect(normalized.ok).toBe(true);
            if (normalized.ok) {
                expect(normalized.ref).toEqual({
                    kind: 'external_file',
                    ext_key: 'AB12CD34',
                    loc: { kind: 'page', value: '2', raw: 'page2' },
                });
            }
        }
    });

    it('rejects malformed ext ids as invalid zotero ids', () => {
        // wrong key length / characters fall through to the Zotero parse
        const normalized = normalizeCitationTag({ id: 'ext-SHORT' });
        expect(normalized.ok).toBe(false);
    });

    it('builds extfile citation keys with and without locators', () => {
        const ref = { kind: 'external_file' as const, ext_key: 'AB12CD34' };
        expect(baseCitationKey(ref)).toBe('extfile:AB12CD34');
        expect(requestedCitationKey({
            ...ref,
            loc: { kind: 'page' as const, value: '2', raw: 'page2' },
        })).toBe('extfile:AB12CD34:page2');
    });

    it('resolves external file refs through getRequestedRef/getResolvedRef', () => {
        const citation = {
            requested_ref: { kind: 'external_file' as const, ext_key: 'AB12CD34' },
            resolved_ref: { kind: 'external_file' as const, ext_key: 'AB12CD34' },
            raw_tag: '<citation id="ext-AB12CD34" loc="page2"/>',
        };
        // loc recovered from the raw tag when refs lack it
        expect(getRequestedRef(citation)).toEqual({
            kind: 'external_file',
            ext_key: 'AB12CD34',
            loc: { kind: 'page', value: '2', raw: 'page2' },
        });
        expect(getResolvedRef(citation)).toEqual({
            kind: 'external_file',
            ext_key: 'AB12CD34',
            loc: { kind: 'page', value: '2', raw: 'page2' },
        });
    });
});

describe('unknown / future ref kinds (cross-app forward compat)', () => {
    // A newer backend (or another connected app) may send a ref kind this
    // client doesn't model. Keying must degrade gracefully — stable,
    // kind-namespaced, non-colliding — rather than assuming a closed set.
    it('builds a stable, kind-namespaced base key for unknown kinds', () => {
        const ref = { kind: 'obsidian_note', note_path: 'vault/Note A.md' } as any;
        const key = baseCitationKey(ref);
        expect(key.startsWith('obsidian_note:')).toBe(true);
        expect(key).toContain('Note A.md');
    });

    it('does not collide two distinct unknown-kind refs onto one key', () => {
        const a = baseCitationKey({ kind: 'obsidian_note', note_path: 'A.md' } as any);
        const b = baseCitationKey({ kind: 'obsidian_note', note_path: 'B.md' } as any);
        expect(a).not.toBe(b);
    });

    it('excludes loc from the base key so markers stay location-independent', () => {
        const withLoc = baseCitationKey({
            kind: 'obsidian_note',
            note_path: 'A.md',
            loc: { kind: 'page', value: '2', raw: 'page2' },
        } as any);
        const withoutLoc = baseCitationKey({ kind: 'obsidian_note', note_path: 'A.md' } as any);
        expect(withLoc).toBe(withoutLoc);
    });

    it('appends the locator only in the full requested key', () => {
        const ref = {
            kind: 'obsidian_note',
            note_path: 'A.md',
            loc: { kind: 'page', value: '2', raw: 'page2' },
        } as any;
        expect(requestedCitationKey(ref)).toBe(`${baseCitationKey(ref)}:page2`);
    });
});
