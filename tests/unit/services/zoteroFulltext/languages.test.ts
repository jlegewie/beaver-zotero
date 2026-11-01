import { describe, expect, it } from 'vitest';
import { languageCode, prominentLanguages, scriptLanguage } from '../../../../src/services/zoteroFulltext/languages';

describe('languageCode', () => {
    it.each([
        ['en', 'en'], ['en-US', 'en'], ['English', 'en'], ['eng', 'en'],
        ['Deutsch', 'de'], ['ger', 'de'], ['de_DE', 'de'],
        ['Français', 'fr'], ['español', 'es'], ['中文', 'zh'], ['zh-CN', 'zh'],
    ])('maps %s to %s', (value, code) => {
        expect(languageCode(value)).toBe(code);
    });

    it('returns null for empty or unreadable values', () => {
        expect(languageCode('')).toBeNull();
        expect(languageCode(null)).toBeNull();
        expect(languageCode('Klingonese')).toBeNull();
    });
});

describe('scriptLanguage', () => {
    it('reads unambiguous scripts from titles', () => {
        expect(scriptLanguage('气候变化研究')).toBe('zh');
        expect(scriptLanguage('東京の気候')).toBe('ja');
        expect(scriptLanguage('기후 변화')).toBe('ko');
        expect(scriptLanguage('Изменение климата')).toBe('ru');
        expect(scriptLanguage('Climate change')).toBeNull();
    });
});

describe('prominentLanguages', () => {
    it('keeps languages with enough items and share, most common first', () => {
        const counts = new Map([['en', 300], ['de', 40], ['fr', 4], ['zh', 20], ['es', 6]]);
        expect(prominentLanguages(counts)).toEqual(['en', 'de', 'zh']);
    });

    it('returns nothing without classified items', () => {
        expect(prominentLanguages(new Map())).toEqual([]);
    });
});
