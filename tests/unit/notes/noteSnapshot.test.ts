import { describe, it, expect } from 'vitest';
import {
    maskVolatileLocators,
    EMPTY_READ_WINDOW,
    encodeReadWindow,
    parseReadWindow,
    quickHash64,
    buildAddressSnapshot,
    parseAddressSnapshot,
    verifyAddressSnapshot,
    type ReadWindow,
} from '../../../src/utils/noteSnapshot';

// =============================================================================
// Helpers
// =============================================================================

/** A simplified single-item citation tag as the simplifier emits it. */
function citation(itemId: string, loc?: string, ref = 'c_ABCD1234_0'): string {
    return `<citation id="${itemId}"${loc ? ` loc="${loc}"` : ''} ref="${ref}"/>`;
}

/** A simplified compound citation tag as the simplifier emits it. */
function compoundCitation(items: string, ref = 'c_AAAA1111+BBBB2222_0'): string {
    return `<citation items="${items}" ref="${ref}"/>`;
}

/** A simplified note projection with `lines` joined by newlines. */
function note(...lines: string[]): string {
    return lines.join('\n');
}

const WINDOW: ReadWindow = { from: 1, to: 3 };

// =============================================================================
// maskVolatileLocators
// =============================================================================

describe('maskVolatileLocators', () => {
    it('returns a note without citations unchanged', () => {
        const simplified = note('<h1>Title</h1>', '<p>Plain prose with page="7" in text</p>', '');
        expect(maskVolatileLocators(simplified)).toBe(simplified);
    });

    it('is invariant under loc= page-label drift', () => {
        const before = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const after = note('<p>Claim ' + citation('1-ABCD1234', 'page17') + '</p>');
        expect(before).not.toBe(after);
        expect(maskVolatileLocators(before)).toBe(maskVolatileLocators(after));
    });

    it('is invariant under compound items= locator drift', () => {
        const before = note(
            '<p>Both ' + compoundCitation('1-AAAA1111:page=3, 1-BBBB2222:page=9') + '</p>',
        );
        const after = note(
            '<p>Both ' + compoundCitation('1-AAAA1111:page=xii, 1-BBBB2222:page=101') + '</p>',
        );
        expect(before).not.toBe(after);
        expect(maskVolatileLocators(before)).toBe(maskVolatileLocators(after));
    });

    it('is SENSITIVE to an item-id change inside items=', () => {
        const before = note(
            '<p>Both ' + compoundCitation('1-AAAA1111:page=3, 1-BBBB2222:page=9') + '</p>',
        );
        const after = note(
            '<p>Both ' + compoundCitation('1-AAAA1111:page=3, 1-CCCC3333:page=9') + '</p>',
        );
        expect(maskVolatileLocators(before)).not.toBe(maskVolatileLocators(after));
    });

    // A locator can itself contain commas (`pageLabelTranslation` splits on
    // `[-–,]`), so the whole run has to be masked, not just up to the first
    // comma — otherwise live drift stays in the digest and the note
    // spuriously fails its own snapshot.
    it('is invariant under drift of a COMMA-CONTAINING compound locator', () => {
        const before = note(
            '<p>Both ' + compoundCitation('1-AAAA1111:page=12, 15, 1-BBBB2222:page=9') + '</p>',
        );
        const after = note(
            '<p>Both ' + compoundCitation('1-AAAA1111:page=xii, xv, 1-BBBB2222:page=101') + '</p>',
        );
        expect(before).not.toBe(after);
        expect(maskVolatileLocators(before)).toBe(maskVolatileLocators(after));
    });

    it('still separates item ids when a locator contains commas', () => {
        const masked = maskVolatileLocators(
            note('<p>' + compoundCitation('1-AAAA1111:page=12, 15, 1-BBBB2222:page=9') + '</p>'),
        );
        expect(masked).toContain('1-AAAA1111');
        expect(masked).toContain('1-BBBB2222');
        expect(masked).not.toContain('15');
        // The item id after a comma-containing locator must NOT be swallowed:
        // changing it still changes the mask.
        const other = maskVolatileLocators(
            note('<p>' + compoundCitation('1-AAAA1111:page=12, 15, 1-CCCC3333:page=9') + '</p>'),
        );
        expect(masked).not.toBe(other);
    });

    it('is SENSITIVE to an item-id change on a single citation', () => {
        const before = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const after = note('<p>Claim ' + citation('1-ZZZZ9999', 'page3') + '</p>');
        expect(maskVolatileLocators(before)).not.toBe(maskVolatileLocators(after));
    });

    it('preserves item ids verbatim in the masked output', () => {
        const masked = maskVolatileLocators(
            note('<p>' + compoundCitation('1-AAAA1111:page=3, 1-BBBB2222:page=9') + '</p>'),
        );
        expect(masked).toContain('1-AAAA1111');
        expect(masked).toContain('1-BBBB2222');
        expect(masked).not.toContain('page=3');
        expect(masked).not.toContain('page=9');
    });

    it('does NOT mask an annotation page attribute', () => {
        const simplified = note(
            '<p><annotation id="a_XYZ" key="XYZ" color="#ffd400" page="12">quoted text</annotation></p>',
        );
        const masked = maskVolatileLocators(simplified);
        expect(masked).toContain('page="12"');
        expect(masked).toBe(simplified);
    });

    it('masks a citation page= attribute but leaves a neighbouring annotation page= alone', () => {
        const simplified = note(
            '<p><annotation id="a_XYZ" key="XYZ" page="12">quoted</annotation> '
            + '<citation id="1-ABCD1234" page="4" ref="c_ABCD1234_0"/></p>',
        );
        const masked = maskVolatileLocators(simplified);
        expect(masked).toContain('<annotation id="a_XYZ" key="XYZ" page="12">');
        expect(masked).not.toContain('page="4"');
    });

    it('does not change the line count', () => {
        const simplified = note(
            '<h1>Title</h1>',
            '<p>A ' + citation('1-ABCD1234', 'page3') + '</p>',
            '<p>B</p>',
        );
        expect(maskVolatileLocators(simplified).split('\n')).toHaveLength(3);
    });
});

// =============================================================================
// Read window
// =============================================================================

describe('read window', () => {
    it('EMPTY_READ_WINDOW is the canonical 0-0 literal', () => {
        expect(EMPTY_READ_WINDOW).toEqual({ from: 0, to: 0 });
        expect(encodeReadWindow(EMPTY_READ_WINDOW)).toBe('0-0');
        expect(parseReadWindow('0-0')).toEqual({ from: 0, to: 0 });
    });

    it('round-trips encode → parse', () => {
        for (const w of [{ from: 1, to: 1 }, { from: 1, to: 50 }, { from: 7, to: 1200 }]) {
            expect(parseReadWindow(encodeReadWindow(w))).toEqual(w);
        }
    });

    it('fails closed on non-numeric parts', () => {
        expect(parseReadWindow('a-3')).toBeNull();
        expect(parseReadWindow('1-b')).toBeNull();
        expect(parseReadWindow('one-two')).toBeNull();
    });

    it('fails closed on a missing separator', () => {
        expect(parseReadWindow('12')).toBeNull();
        expect(parseReadWindow('')).toBeNull();
    });

    it('fails closed on empty parts', () => {
        expect(parseReadWindow('1-')).toBeNull();
        expect(parseReadWindow('-')).toBeNull();
    });

    it('fails closed on negative numbers', () => {
        expect(parseReadWindow('-1-3')).toBeNull();
        expect(parseReadWindow('1--3')).toBeNull();
    });

    it('fails closed on non-integers', () => {
        expect(parseReadWindow('1.5-3')).toBeNull();
        expect(parseReadWindow('1-3.5')).toBeNull();
        expect(parseReadWindow('1e2-300')).toBeNull();
    });

    it('fails closed on whitespace', () => {
        expect(parseReadWindow(' 1-3')).toBeNull();
        expect(parseReadWindow('1 - 3')).toBeNull();
    });

    it('fails closed on an inverted window', () => {
        expect(parseReadWindow('5-3')).toBeNull();
        expect(parseReadWindow('1-0')).toBeNull();
    });

    it('fails closed on extra segments', () => {
        expect(parseReadWindow('1-2-3')).toBeNull();
    });
});

// =============================================================================
// quickHash64
// =============================================================================

describe('quickHash64', () => {
    it('emits 16 lowercase hex characters', () => {
        expect(quickHash64('some note content')).toMatch(/^[0-9a-f]{16}$/);
        expect(quickHash64('')).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic', () => {
        expect(quickHash64('<p>hello</p>')).toBe(quickHash64('<p>hello</p>'));
    });

    it('contains no colon, so the snapshot token splits unambiguously', () => {
        for (const input of ['', 'a', '<p>x</p>\n<p>y</p>', 'a'.repeat(5000)]) {
            expect(quickHash64(input)).not.toContain(':');
        }
    });

    it('differs for different content', () => {
        expect(quickHash64('a')).not.toBe(quickHash64('b'));
        expect(quickHash64('')).not.toBe(quickHash64('a'));
    });

    it('differs for equal-length transpositions (order matters)', () => {
        expect(quickHash64('<p>alpha</p>')).not.toBe(quickHash64('<p>alpah</p>'));
        expect(quickHash64('ab')).not.toBe(quickHash64('ba'));
    });
});

// =============================================================================
// buildAddressSnapshot / parseAddressSnapshot / verifyAddressSnapshot
// =============================================================================

describe('address snapshot token', () => {
    const simplified = note('<h1>Title</h1>', '<p>First para</p>', '<p>Second para</p>');

    it('has the documented four-part shape', () => {
        const token = buildAddressSnapshot(simplified, WINDOW);
        const parts = token.split(':');
        expect(parts).toHaveLength(4);
        expect(parts[0]).toBe('h');
        expect(parts[1]).toMatch(/^[0-9a-f]{16}$/);
        expect(parts[2]).toBe(String(simplified.length));
        expect(parts[3]).toBe('1-3');
    });

    // A token built from an inverted window would be rejected by
    // verifyAddressSnapshot against the very note it was built from — an
    // unexplainable permanent mismatch. Refuse to mint one.
    it('throws on a window its own parser would refuse', () => {
        expect(() => buildAddressSnapshot(simplified, { from: 1, to: 0 })).toThrow(/invalid read window/);
        expect(() => buildAddressSnapshot(simplified, { from: -1, to: 3 })).toThrow(/invalid read window/);
        expect(() => buildAddressSnapshot(simplified, { from: 1.5, to: 3 })).toThrow(/invalid read window/);
        // The canonical empty window is legal and must not throw.
        expect(() => buildAddressSnapshot(simplified, EMPTY_READ_WINDOW)).not.toThrow();
    });

    it('is stable for the same content and window', () => {
        expect(buildAddressSnapshot(simplified, WINDOW))
            .toBe(buildAddressSnapshot(simplified, { from: 1, to: 3 }));
    });

    it('changes when the content changes', () => {
        const edited = note('<h1>Title</h1>', '<p>First para EDITED</p>', '<p>Second para</p>');
        expect(buildAddressSnapshot(edited, WINDOW)).not.toBe(buildAddressSnapshot(simplified, WINDOW));
    });

    it('changes for equal-length differing content (the digest is doing work)', () => {
        const swapped = note('<h1>Title</h1>', '<p>Frist para</p>', '<p>Second para</p>');
        expect(swapped).toHaveLength(simplified.length);
        expect(swapped).not.toBe(simplified);
        const a = buildAddressSnapshot(simplified, WINDOW);
        const b = buildAddressSnapshot(swapped, WINDOW);
        // Same length term, different digest.
        expect(a.split(':')[2]).toBe(b.split(':')[2]);
        expect(a).not.toBe(b);
    });

    it('changes when only the window changes', () => {
        expect(buildAddressSnapshot(simplified, { from: 1, to: 3 }))
            .not.toBe(buildAddressSnapshot(simplified, { from: 1, to: 2 }));
        expect(buildAddressSnapshot(simplified, EMPTY_READ_WINDOW))
            .not.toBe(buildAddressSnapshot(simplified, { from: 1, to: 3 }));
    });

    it('parses a well-formed token back to its window', () => {
        const parsed = parseAddressSnapshot(buildAddressSnapshot(simplified, { from: 4, to: 60 }));
        expect(parsed).not.toBeNull();
        expect(parsed!.window).toEqual({ from: 4, to: 60 });
    });

    it('parses the empty-window token', () => {
        const parsed = parseAddressSnapshot(buildAddressSnapshot(simplified, EMPTY_READ_WINDOW));
        expect(parsed!.window).toEqual(EMPTY_READ_WINDOW);
    });

    it('rejects malformed tokens structurally', () => {
        const token = buildAddressSnapshot(simplified, WINDOW);
        const digest = token.split(':')[1];
        expect(parseAddressSnapshot('')).toBeNull();
        expect(parseAddressSnapshot('garbage')).toBeNull();
        expect(parseAddressSnapshot(`x:${digest}:10:1-3`)).toBeNull();          // wrong prefix
        expect(parseAddressSnapshot(`h:${digest}:10`)).toBeNull();              // missing window
        expect(parseAddressSnapshot(`h:${digest}:10:1-3:extra`)).toBeNull();    // extra part
        expect(parseAddressSnapshot(`h:nothex:10:1-3`)).toBeNull();             // bad digest
        expect(parseAddressSnapshot(`h:${digest.slice(1)}:10:1-3`)).toBeNull(); // short digest
        expect(parseAddressSnapshot(`h:${digest}:ten:1-3`)).toBeNull();         // bad length
        expect(parseAddressSnapshot(`h:${digest}:-1:1-3`)).toBeNull();          // negative length
        expect(parseAddressSnapshot(`h:${digest}:10:3-1`)).toBeNull();          // inverted window
        expect(parseAddressSnapshot(`h:${digest}:10:garbage`)).toBeNull();      // bad window
    });

    it('verifies an unmodified token against its own note and returns the window', () => {
        const token = buildAddressSnapshot(simplified, WINDOW);
        expect(verifyAddressSnapshot(token, simplified)).toEqual(WINDOW);
    });

    it('verifies the empty-window token', () => {
        const token = buildAddressSnapshot(simplified, EMPTY_READ_WINDOW);
        expect(verifyAddressSnapshot(token, simplified)).toEqual({ from: 0, to: 0 });
    });

    it('fails verification when the note changed underneath the token', () => {
        const token = buildAddressSnapshot(simplified, WINDOW);
        const edited = note('<h1>Title</h1>', '<p>First para</p>', '<p>Second para (edited)</p>');
        expect(verifyAddressSnapshot(token, edited)).toBeNull();
    });

    it('fails verification when the window suffix was hand-widened', () => {
        const token = buildAddressSnapshot(simplified, { from: 1, to: 100 });
        const widened = token.replace(/:1-100$/, ':1-9999');
        expect(widened).not.toBe(token);
        // Structurally still a valid token — that is exactly why the window has
        // to be inside the digest.
        expect(parseAddressSnapshot(widened)!.window).toEqual({ from: 1, to: 9999 });
        expect(verifyAddressSnapshot(widened, simplified)).toBeNull();
    });

    it('fails verification when the window suffix was narrowed or re-based', () => {
        const token = buildAddressSnapshot(simplified, { from: 1, to: 3 });
        expect(verifyAddressSnapshot(token.replace(/:1-3$/, ':1-2'), simplified)).toBeNull();
        expect(verifyAddressSnapshot(token.replace(/:1-3$/, ':2-3'), simplified)).toBeNull();
        expect(verifyAddressSnapshot(token.replace(/:1-3$/, ':0-0'), simplified)).toBeNull();
    });

    it('fails verification on a zero-padded (non-canonical) window', () => {
        const token = buildAddressSnapshot(simplified, { from: 1, to: 3 });
        expect(verifyAddressSnapshot(token.replace(/:1-3$/, ':01-03'), simplified)).toBeNull();
    });

    it('fails verification on a missing or garbage suffix', () => {
        const token = buildAddressSnapshot(simplified, WINDOW);
        expect(verifyAddressSnapshot(token.replace(/:1-3$/, ''), simplified)).toBeNull();
        expect(verifyAddressSnapshot(token.replace(/:1-3$/, ':nonsense'), simplified)).toBeNull();
        expect(verifyAddressSnapshot('', simplified)).toBeNull();
        expect(verifyAddressSnapshot('h:deadbeefdeadbeef:12:1-3', simplified)).toBeNull();
    });

    it('fails verification when the length term was tampered with', () => {
        const token = buildAddressSnapshot(simplified, WINDOW);
        const parts = token.split(':');
        const tampered = [parts[0], parts[1], String(Number(parts[2]) + 1), parts[3]].join(':');
        expect(verifyAddressSnapshot(tampered, simplified)).toBeNull();
    });

    it('survives citation locator drift (the reason masking exists)', () => {
        const read = note(
            '<h1>Title</h1>',
            '<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>',
            '<p>Both ' + compoundCitation('1-AAAA1111:page=3, 1-BBBB2222:page=9') + '</p>',
        );
        const laterWithDriftedLabels = note(
            '<h1>Title</h1>',
            '<p>Claim ' + citation('1-ABCD1234', 'page17') + '</p>',
            '<p>Both ' + compoundCitation('1-AAAA1111:page=xii, 1-BBBB2222:page=101') + '</p>',
        );
        expect(read).not.toBe(laterWithDriftedLabels);
        const token = buildAddressSnapshot(read, WINDOW);
        expect(verifyAddressSnapshot(token, laterWithDriftedLabels)).toEqual(WINDOW);
    });

    it('still fails when real content changed alongside locator drift', () => {
        const read = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const later = note('<p>Claim REWRITTEN ' + citation('1-ABCD1234', 'page17') + '</p>');
        const token = buildAddressSnapshot(read, { from: 1, to: 1 });
        expect(verifyAddressSnapshot(token, later)).toBeNull();
    });
});
