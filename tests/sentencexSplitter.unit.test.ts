/**
 * Unit tests for the sentencex-wasm adapter helpers.
 *
 * The adapter has two pieces of logic that need verification independent
 * of the WASM module itself:
 *
 *   1. `buildByteOffsetTable` — UTF-16 → UTF-8 byte counter that produces
 *      a cumulative byte offset for every JS string code unit.
 *   2. `byteRangesToCharRanges` — translates the byte-indexed boundaries
 *      that sentencex-wasm returns into JS string code-unit ranges that
 *      align with the char-indexed `PageText.source` map used downstream.
 *   3. `normalizeLanguageCode` — maps free-text Zotero language fields
 *      into ISO 639-1 codes for sentencex.
 *
 * These tests run hermetically (no WASM, no ChromeUtils, no Zotero).
 * The byte-offset paths are the only NEW logic introduced by the
 * sentencex integration that doesn't depend on the WASM blob, so they
 * are the highest-leverage place to put fast unit coverage.
 */

import { describe, it, expect } from 'vitest';
import {
    buildByteOffsetTable,
    byteRangesToCharRanges,
    normalizeLanguageCode,
    type SentencexBoundary,
} from '../src/services/pdf/SentencexSplitter';

// ---------------------------------------------------------------------------
// buildByteOffsetTable
// ---------------------------------------------------------------------------

describe('buildByteOffsetTable', () => {
    it('returns [0] for empty input', () => {
        const t = buildByteOffsetTable('');
        expect(t.length).toBe(1);
        expect(t[0]).toBe(0);
    });

    it('counts ASCII as 1 byte each', () => {
        const t = buildByteOffsetTable('Hello');
        // length+1 entries; each char advances by 1 byte
        expect(Array.from(t)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('counts a Latin-1 accented char as 2 bytes', () => {
        // "café": c, a, f are 1 byte; é is 2 bytes (U+00E9)
        const t = buildByteOffsetTable('café');
        expect(Array.from(t)).toEqual([0, 1, 2, 3, 5]);
    });

    it('counts BMP CJK as 3 bytes per char', () => {
        // 你好 = U+4F60 U+597D, each 3 UTF-8 bytes
        const t = buildByteOffsetTable('你好');
        expect(Array.from(t)).toEqual([0, 3, 6]);
    });

    it('counts an astral-plane code point as 4 bytes on the high surrogate', () => {
        // 𝕊 = U+1D54A → surrogate pair D835 DD4A, 4 UTF-8 bytes
        const text = '𝕊';
        const t = buildByteOffsetTable(text);
        // text.length === 2 (two UTF-16 code units)
        expect(text.length).toBe(2);
        expect(t.length).toBe(3);
        // High surrogate at index 0 charges all 4 bytes; low surrogate
        // contributes 0 so its entry sits at the same offset as the
        // post-character position.
        expect(Array.from(t)).toEqual([0, 4, 4]);
    });

    it('handles a mixed string end-to-end', () => {
        // "a é 你 𝕊"  (with single-space separators)
        // a   = 1 byte
        // ' ' = 1 byte
        // é   = 2 bytes
        // ' ' = 1 byte
        // 你  = 3 bytes
        // ' ' = 1 byte
        // 𝕊   = 4 bytes (surrogate pair)
        const text = 'a é 你 𝕊';
        const t = buildByteOffsetTable(text);
        // Index 0: 'a' → 0
        // Index 1: ' ' → 1
        // Index 2: 'é' → 2
        // Index 3: ' ' → 4 (after 1+1+2)
        // Index 4: '你' → 5
        // Index 5: ' ' → 8 (after 1+1+2+1+3)
        // Index 6: high-surrogate → 9
        // Index 7: low-surrogate  → 13 (high charged 4 bytes)
        // Index 8: end-of-string → 13
        expect(Array.from(t)).toEqual([0, 1, 2, 4, 5, 8, 9, 13, 13]);
    });

    it('the final entry equals the UTF-8 byte length of the string', () => {
        const text = 'Test café 你好 𝕊!';
        const t = buildByteOffsetTable(text);
        const utf8Length = new TextEncoder().encode(text).length;
        expect(t[text.length]).toBe(utf8Length);
    });

    it('agrees with TextEncoder for every prefix', () => {
        const text = 'Pragmatic “smart” quotes — and an em dash. Also é, ü, ñ.';
        const t = buildByteOffsetTable(text);
        const encoder = new TextEncoder();
        for (let i = 0; i <= text.length; i++) {
            // For positions inside a surrogate pair, slicing UTF-16 at
            // the low surrogate yields a leading lone surrogate which
            // TextEncoder replaces with U+FFFD (3 bytes). Skip those
            // checks — they correspond to the "low surrogate stays at
            // the same byte offset" rule which we test directly above.
            const code = i < text.length ? text.charCodeAt(i) : 0;
            if (code >= 0xdc00 && code <= 0xdfff) continue;
            const expected = encoder.encode(text.slice(0, i)).length;
            expect(t[i], `byte offset at index ${i}`).toBe(expected);
        }
    });
});

// ---------------------------------------------------------------------------
// byteRangesToCharRanges
// ---------------------------------------------------------------------------

function fakeBoundary(
    text: string,
    start_index: number,
    end_index: number,
): SentencexBoundary {
    return {
        text,
        start_index,
        end_index,
        boundary_symbol: null,
        is_paragraph_break: false,
    };
}

describe('byteRangesToCharRanges', () => {
    it('returns an empty array when there are no boundaries', () => {
        const t = buildByteOffsetTable('Hello.');
        expect(byteRangesToCharRanges([], t)).toEqual([]);
    });

    it('round-trips ASCII boundaries unchanged', () => {
        const text = 'Hello world. Goodbye.';
        const t = buildByteOffsetTable(text);
        // Pretend sentencex returned two sentences
        const boundaries = [
            fakeBoundary('Hello world. ', 0, 13),
            fakeBoundary('Goodbye.', 13, 21),
        ];
        const ranges = byteRangesToCharRanges(boundaries, t);
        expect(ranges).toEqual([
            { start: 0, end: 13 },
            { start: 13, end: 21 },
        ]);
        expect(text.slice(ranges[0].start, ranges[0].end)).toBe(
            'Hello world. ',
        );
        expect(text.slice(ranges[1].start, ranges[1].end)).toBe('Goodbye.');
    });

    it('translates UTF-8 byte offsets across multi-byte chars', () => {
        // "a café. Bye 你好."
        //  index 0: 'a'   byte 0..1
        //  index 1: ' '   byte 1..2
        //  index 2: 'c'   byte 2..3
        //  index 3: 'a'   byte 3..4
        //  index 4: 'f'   byte 4..5
        //  index 5: 'é'   byte 5..7 (2 bytes)
        //  index 6: '.'   byte 7..8
        //  index 7: ' '   byte 8..9
        //  index 8: 'B'   byte 9..10
        //  index 9: 'y'   byte 10..11
        //  index 10:'e'   byte 11..12
        //  index 11:' '   byte 12..13
        //  index 12:'你'  byte 13..16 (3 bytes)
        //  index 13:'好'  byte 16..19 (3 bytes)
        //  index 14:'.'   byte 19..20
        const text = 'a café. Bye 你好.';
        const t = buildByteOffsetTable(text);
        // Verify the table to catch any drift in the test setup
        expect(Array.from(t)).toEqual([
            0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 16, 19, 20,
        ]);

        // Two sentences in byte space
        const boundaries = [
            fakeBoundary('a café. ', 0, 8),  // ends after the first '. '
            fakeBoundary('Bye 你好.', 9, 20),
        ];
        const ranges = byteRangesToCharRanges(boundaries, t);
        // Char-space ranges
        expect(ranges).toEqual([
            { start: 0, end: 7 }, // "a café."
            { start: 8, end: 15 }, // "Bye 你好."
        ]);
        expect(text.slice(ranges[0].start, ranges[0].end)).toBe('a café.');
        expect(text.slice(ranges[1].start, ranges[1].end)).toBe('Bye 你好.');
    });

    it('handles surrogate pairs by emitting the full range', () => {
        // "𝕊." → indices 0,1 = surrogate pair, index 2 = '.'
        // Bytes: high-surrogate charges 4; low stays at 4; '.' is byte 4..5
        const text = '𝕊.';
        const t = buildByteOffsetTable(text);
        expect(Array.from(t)).toEqual([0, 4, 4, 5]);

        const boundaries = [fakeBoundary('𝕊.', 0, 5)];
        const ranges = byteRangesToCharRanges(boundaries, t);
        expect(ranges).toEqual([{ start: 0, end: 3 }]);
        expect(text.slice(ranges[0].start, ranges[0].end)).toBe('𝕊.');
    });

    it('drops empty ranges (boundary maps to zero-length char span)', () => {
        const text = 'Hello.';
        const t = buildByteOffsetTable(text);
        // Degenerate boundary: start == end at byte offset 3 ("l|l")
        // produces an empty char range and is dropped.
        const boundaries = [fakeBoundary('', 3, 3)];
        const ranges = byteRangesToCharRanges(boundaries, t);
        expect(ranges).toEqual([]);
    });

    it('cursor is monotonic — out-of-order boundaries are clamped forward', () => {
        // Sentencex always returns boundaries in document order, so the
        // adapter walks the byte table forward only. If a caller passes
        // an out-of-order start (lower than the cursor), advanceTo
        // returns the cursor unchanged. This is a design contract
        // documented on byteRangesToCharRanges.
        const text = 'Hello.';
        const t = buildByteOffsetTable(text);
        const boundaries = [
            fakeBoundary('lo.', 3, 6),
            fakeBoundary('Hello.', 0, 6), // out of order on purpose
        ];
        const ranges = byteRangesToCharRanges(boundaries, t);
        // First boundary maps cleanly (3, 6).
        // Second boundary: cursor is now at 6, advanceTo(0) returns 6,
        // advanceTo(6) returns 6 → empty range, dropped.
        expect(ranges).toEqual([{ start: 3, end: 6 }]);
    });

    it('preserves order across many sentences in a paragraph', () => {
        const text =
            'First sentence. Second one. Third with é. Fourth 𝕊 here. Fifth!';
        const t = buildByteOffsetTable(text);
        // Build boundaries from a manual scan rather than from the WASM,
        // to keep the test hermetic. We'll split on every ". " and the
        // final terminator. Compute byte offsets via TextEncoder.
        const encoder = new TextEncoder();
        const sentenceTexts = [
            'First sentence. ',
            'Second one. ',
            'Third with é. ',
            'Fourth 𝕊 here. ',
            'Fifth!',
        ];
        let byteCursor = 0;
        const boundaries: SentencexBoundary[] = sentenceTexts.map((s) => {
            const sBytes = encoder.encode(s).length;
            const b = fakeBoundary(s, byteCursor, byteCursor + sBytes);
            byteCursor += sBytes;
            return b;
        });

        const ranges = byteRangesToCharRanges(boundaries, t);
        expect(ranges.length).toBe(sentenceTexts.length);
        // Reconstruct each sentence from its char range and check
        // it matches the original (modulo that surrogate slices preserve
        // both halves).
        const reconstructed = ranges
            .map((r) => text.slice(r.start, r.end))
            .join('');
        expect(reconstructed).toBe(text);
    });
});

// ---------------------------------------------------------------------------
// normalizeLanguageCode
// ---------------------------------------------------------------------------

describe('normalizeLanguageCode', () => {
    it('defaults empty / null / undefined to "en"', () => {
        expect(normalizeLanguageCode(null)).toBe('en');
        expect(normalizeLanguageCode(undefined)).toBe('en');
        expect(normalizeLanguageCode('')).toBe('en');
        expect(normalizeLanguageCode('   ')).toBe('en');
    });

    it('passes through canonical ISO 639-1 codes', () => {
        expect(normalizeLanguageCode('en')).toBe('en');
        expect(normalizeLanguageCode('de')).toBe('de');
        expect(normalizeLanguageCode('fr')).toBe('fr');
        expect(normalizeLanguageCode('ja')).toBe('ja');
    });

    it('lowercases and strips region tags', () => {
        expect(normalizeLanguageCode('EN')).toBe('en');
        expect(normalizeLanguageCode('en-US')).toBe('en');
        expect(normalizeLanguageCode('en_GB')).toBe('en');
        expect(normalizeLanguageCode('zh-TW')).toBe('zh');
        expect(normalizeLanguageCode('  pt_BR  ')).toBe('pt');
    });

    it('maps common ISO 639-2 codes to ISO 639-1', () => {
        expect(normalizeLanguageCode('eng')).toBe('en');
        expect(normalizeLanguageCode('ger')).toBe('de');
        expect(normalizeLanguageCode('deu')).toBe('de');
        expect(normalizeLanguageCode('fre')).toBe('fr');
        expect(normalizeLanguageCode('fra')).toBe('fr');
        expect(normalizeLanguageCode('spa')).toBe('es');
        expect(normalizeLanguageCode('jpn')).toBe('ja');
        expect(normalizeLanguageCode('zho')).toBe('zh');
        expect(normalizeLanguageCode('chi')).toBe('zh');
        expect(normalizeLanguageCode('ara')).toBe('ar');
        expect(normalizeLanguageCode('nld')).toBe('nl');
        expect(normalizeLanguageCode('dut')).toBe('nl');
    });

    it('maps common English language names to ISO 639-1', () => {
        expect(normalizeLanguageCode('English')).toBe('en');
        expect(normalizeLanguageCode('GERMAN')).toBe('de');
        expect(normalizeLanguageCode('Deutsch')).toBe('de');
        expect(normalizeLanguageCode('French')).toBe('fr');
        expect(normalizeLanguageCode('japanese')).toBe('ja');
    });

    it('passes through unknown codes unchanged so sentencex can fall back', () => {
        // sentencex tolerates anything; we just clean it up.
        expect(normalizeLanguageCode('xx')).toBe('xx');
        expect(normalizeLanguageCode('Klingon')).toBe('klingon');
    });
});
