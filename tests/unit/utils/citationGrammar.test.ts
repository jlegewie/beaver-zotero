import { describe, expect, it } from 'vitest';
import {
    baseCitationKey,
    externalCompatKey,
    getPageLocator,
    locatorFromLegacyPage,
    normalizeCitationTag,
    parseLoc,
    parseZoteroId,
    requestedCitationKey,
} from '../../../react/utils/citationGrammar';

describe('citationGrammar', () => {
    it('parses registered locator prefixes and ranges', () => {
        expect(parseLoc('p10')).toEqual({ kind: 'paragraph', value: '10', raw: 'p10' });
        expect(parseLoc('page12')).toEqual({ kind: 'page', value: '12', raw: 'page12' });
        expect(parseLoc('s343')).toEqual({ kind: 'sentence', value: '343', raw: 's343' });
        expect(parseLoc('s0-s8')).toEqual({ kind: 'sentence', value: '0-8', raw: 's0-s8' });
        expect(parseLoc('paragraph12')).toEqual({ kind: 'paragraph', value: '12', raw: 'paragraph12' });
        expect(parseLoc('heading3')).toEqual({ kind: 'heading', value: '3', raw: 'heading3' });
        expect(parseLoc('list8')).toEqual({ kind: 'list', value: '8', raw: 'list8' });
        expect(parseLoc('caption12')).toEqual({ kind: 'caption', value: '12', raw: 'caption12' });
        expect(parseLoc('footnote4')).toEqual({ kind: 'footnote', value: '4', raw: 'footnote4' });
        expect(parseLoc('margin6')).toEqual({ kind: 'margin', value: '6', raw: 'margin6' });
        expect(parseLoc('fig2')).toEqual({ kind: 'figure', value: '2', raw: 'fig2' });
        expect(parseLoc('eq4')).toEqual({ kind: 'equation', value: '4', raw: 'eq4' });
        expect(parseLoc('table3')).toEqual({ kind: 'table', value: '3', raw: 'table3' });
        expect(parseLoc('tab3')).toEqual({ kind: 'table', value: '3', raw: 'tab3' });
        expect(parseLoc('p10-p12')).toEqual({ kind: 'paragraph', value: '10-12', raw: 'p10-p12' });
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

    it('builds requested, base, and external compatibility keys', () => {
        const zotero = normalizeCitationTag({ id: '1-ABC', loc: 'page3' });
        expect(zotero.ok && requestedCitationKey(zotero.ref)).toBe('zotero:1-ABC:page3');
        expect(zotero.ok && baseCitationKey(zotero.ref)).toBe('zotero:1-ABC');
        expect(zotero.ok && getPageLocator(zotero.ref)).toBe('3');

        expect(externalCompatKey('W1')).toBe('external:W1');
        expect(requestedCitationKey({ kind: 'external', external_id: 'W1', source: 'openalex' })).toBe('external:openalex:W1');
    });
});
