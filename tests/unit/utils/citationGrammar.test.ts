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
        expect(parseLoc('p10')).toEqual({ kind: 'page', value: '10', raw: 'p10' });
        expect(parseLoc('page12')).toEqual({ kind: 'page', value: '12', raw: 'page12' });
        expect(parseLoc('s0-s8')).toEqual({ kind: 'sentence', value: '0-8', raw: 's0-s8' });
        expect(parseLoc('fig2')).toEqual({ kind: 'figure', value: '2', raw: 'fig2' });
        expect(parseLoc('eq4')).toEqual({ kind: 'equation', value: '4', raw: 'eq4' });
        expect(parseLoc('tab3')).toEqual({ kind: 'table', value: '3', raw: 'tab3' });
        expect(parseLoc('p10-p12')).toEqual({ kind: 'page', value: '10-12', raw: 'p10-p12' });
    });

    it('keeps unknown and legacy page locators stable', () => {
        expect(parseLoc('10-12')).toEqual({ kind: 'unknown', value: '10-12', raw: '10-12' });
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
        expect(normalizeCitationTag({ id: '1-ABC', loc: 'p3' })).toMatchObject({
            ok: true,
            ref: { kind: 'zotero', library_id: 1, zotero_key: 'ABC', loc: { kind: 'page', value: '3', raw: 'p3' } },
        });
        expect(normalizeCitationTag({ att_id: '1-ATT', sid: 's0-s8' })).toMatchObject({
            ok: true,
            ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATT', loc: { kind: 'sentence', value: '0-8', raw: 's0-s8' } },
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
        const zotero = normalizeCitationTag({ id: '1-ABC', loc: 'p3' });
        expect(zotero.ok && requestedCitationKey(zotero.ref)).toBe('zotero:1-ABC:p3');
        expect(zotero.ok && baseCitationKey(zotero.ref)).toBe('zotero:1-ABC');
        expect(zotero.ok && getPageLocator(zotero.ref)).toBe('3');

        expect(externalCompatKey('W1')).toBe('external:W1');
        expect(requestedCitationKey({ kind: 'external', external_id: 'W1', source: 'openalex' })).toBe('external:openalex:W1');
    });
});
