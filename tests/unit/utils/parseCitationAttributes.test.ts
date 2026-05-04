import { describe, it, expect } from 'vitest';
import { parseCitationAttributes } from '../../../react/types/citations';

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
                'item_id="1-ABC" att_id="1-XYZ" external_id="ext:1" sid="s1" page="5"'
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
});
