import { describe, it, expect } from 'vitest';
import { computeCitationKeyFromAttrs, getCitationKey, parseCitationAttributes } from '../../../react/types/citations';

describe('parseCitationAttributes', () => {
    describe('double-quoted attributes', () => {
        it('parses standard double-quoted attributes', () => {
            const result = parseCitationAttributes('item_id="1-ABC123" sid="s0-s8" page="10"');
            expect(result).toEqual({ item_id: '1-ABC123', sid: 's0-s8', page: '10' });
        });

        it('parses att_id', () => {
            const result = parseCitationAttributes('att_id="1-XYZ789"');
            expect(result).toEqual({ att_id: '1-XYZ789' });
        });

        it('parses external_id', () => {
            const result = parseCitationAttributes('external_id="semantic_scholar:12345"');
            expect(result).toEqual({ external_id: 'semantic_scholar:12345' });
        });

        it('parses all recognized attributes together', () => {
            const result = parseCitationAttributes(
                'id="1-ID" item_id="1-ABC" att_id="1-XYZ" external_id="ext:1" loc="p12" sid="s1" page="5"'
            );
            expect(result).toEqual({
                id: '1-ID',
                item_id: '1-ABC',
                att_id: '1-XYZ',
                external_id: 'ext:1',
                loc: 'p12',
                sid: 's1',
                page: '5',
            });
        });
    });

    describe('single-quoted attributes', () => {
        it('parses single-quoted attributes', () => {
            const result = parseCitationAttributes("item_id='1-ABC123' page='10'");
            expect(result).toEqual({ item_id: '1-ABC123', page: '10' });
        });

        it('parses all recognized attributes with single quotes', () => {
            const result = parseCitationAttributes(
                "item_id='1-ABC' att_id='1-XYZ' external_id='ext:1' sid='s1' page='5'"
            );
            expect(result).toEqual({
                item_id: '1-ABC',
                att_id: '1-XYZ',
                external_id: 'ext:1',
                sid: 's1',
                page: '5',
            });
        });
    });

    describe('mixed-quote attributes', () => {
        it('handles double-quoted item_id and single-quoted page', () => {
            const result = parseCitationAttributes('item_id="1-ABC" page=\'5\'');
            expect(result).toEqual({ item_id: '1-ABC', page: '5' });
        });

        it('handles single-quoted item_id and double-quoted sid', () => {
            const result = parseCitationAttributes("item_id='1-ABC' sid=\"s0-s8\"");
            expect(result).toEqual({ item_id: '1-ABC', sid: 's0-s8' });
        });
    });

    describe('attribute name normalization', () => {
        it('normalizes attachment_id to att_id (double quotes)', () => {
            const result = parseCitationAttributes('attachment_id="1-XYZ"');
            expect(result).toEqual({ att_id: '1-XYZ' });
        });

        it('normalizes attachment_id to att_id (single quotes)', () => {
            const result = parseCitationAttributes("attachment_id='1-XYZ'");
            expect(result).toEqual({ att_id: '1-XYZ' });
        });
    });

    describe('edge cases', () => {
        it('returns empty object for empty string', () => {
            expect(parseCitationAttributes('')).toEqual({});
        });

        it('ignores unrecognized attributes', () => {
            const result = parseCitationAttributes('item_id="1-ABC" class="highlight" data_foo="bar"');
            expect(result).toEqual({ item_id: '1-ABC' });
        });

        it('handles empty attribute values (double quotes)', () => {
            const result = parseCitationAttributes('item_id="" page=""');
            expect(result).toEqual({ item_id: '', page: '' });
        });

        it('handles empty attribute values (single quotes)', () => {
            const result = parseCitationAttributes("item_id='' page=''");
            expect(result).toEqual({ item_id: '', page: '' });
        });

        it('ignores unquoted attribute values', () => {
            const result = parseCitationAttributes('item_id=1-ABC page=5');
            expect(result).toEqual({});
        });

        it('handles extra whitespace between attributes', () => {
            const result = parseCitationAttributes('  item_id="1-ABC"   page="5"  ');
            expect(result).toEqual({ item_id: '1-ABC', page: '5' });
        });
    });

    describe('citation keys', () => {
        it('uses loc for Beaver Extract record ids', () => {
            expect(computeCitationKeyFromAttrs({
                item_id: '1-ABC',
                loc: 'p12',
            })).toBe('zotero:1-ABC:p12');
        });

        it('builds base keys from structured refs', () => {
            expect(getCitationKey({
                resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'RESOLVED' },
            })).toBe('zotero:1-RESOLVED');

            expect(getCitationKey({
                requested_ref: { kind: 'external', source: 'openalex', external_id: 'W123' },
            })).toBe('external:openalex:W123');
        });

        it('keeps ref-only footer citations from collapsing to the empty key', () => {
            const keys = [
                getCitationKey({
                    resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'SOURCE1' },
                }),
                getCitationKey({
                    resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'SOURCE2' },
                }),
            ];

            expect(keys).toEqual(['zotero:1-SOURCE1', 'zotero:1-SOURCE2']);
            expect(new Set(keys).size).toBe(2);
            expect(keys).not.toContain('');
        });

        it('falls back to raw tags when no structured ref is present', () => {
            expect(getCitationKey({
                raw_tag: '<citation item_id="2-RAW"/>',
            })).toBe('zotero:2-RAW');
        });

        it('builds external-file keys from ext ids', () => {
            expect(getCitationKey({
                resolved_ref: { kind: 'external_file', ext_key: 'AB12CD34' },
            })).toBe('extfile:AB12CD34');
            expect(computeCitationKeyFromAttrs({
                id: 'ext-AB12CD34',
                loc: 'page2',
            })).toBe('extfile:AB12CD34:page2');
        });
    });
});
