import { describe, it, expect } from 'vitest';
import {
    maskVolatileLocators,
    quickHash64,
    snapshotNoteId,
    buildAddressSnapshot,
    checkAddressSnapshot,
    isAddressSnapshotToken,
    type AddressSnapshotStatus,
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

/**
 * "Do these block numbers still resolve?" — true for `match` AND
 * `locator_drift`, since drift moves attribute values only and never a line
 * boundary. Local to this file on purpose: the module exports the VERDICT, so
 * no caller can ask the weaker question without seeing that it is the weaker
 * one.
 */
function addressable(token: string, noteId: string, simplified: string): boolean {
    const status: AddressSnapshotStatus = checkAddressSnapshot(token, noteId, simplified);
    return status === 'match' || status === 'locator_drift';
}


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
// snapshotNoteId / buildAddressSnapshot / isAddressSnapshotToken / checkAddressSnapshot
// =============================================================================

describe('address snapshot token', () => {
    const simplified = note('<h1>Title</h1>', '<p>First para</p>', '<p>Second para</p>');
    const NOTE_A = snapshotNoteId(1, 'ABCD1234');
    const NOTE_B = snapshotNoteId(1, 'ZZZZ9999');

    it('has the documented four-part shape', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        const parts = token.split(':');
        expect(parts).toHaveLength(4);
        expect(parts[0]).toBe('h2');
        expect(parts[1]).toMatch(/^[0-9a-f]{16}$/);
        expect(parts[2]).toBe(String(simplified.length));
        expect(parts[3]).toMatch(/^[0-9a-f]{16}$/);
    });

    // The two lanes must genuinely differ, or the unmasked one carries no
    // information and the locator-drift verdict can never fire.
    it('gives the two lanes different digests for a note carrying a locator', () => {
        const withLocator = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const parts = buildAddressSnapshot(NOTE_A, withLocator).split(':');
        expect(parts[1]).not.toBe(parts[3]);
    });

    // The library part is PORTABLE (`u` / `g<groupID>`), not the device-local
    // libraryID: a token minted while reading on one computer is verified when
    // the edit runs on another, and a group's libraryID differs between them.
    it('builds the note id from the portable library ref and the key', () => {
        const prevZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Libraries: { userLibraryID: 1 },
            Groups: { getGroupIDFromLibraryID: (id: number) => (id === 7 ? 4321 : 0) },
        };
        try {
            expect(snapshotNoteId(1, 'ABCD1234')).toBe('u-ABCD1234');
            expect(snapshotNoteId(7, 'ZZZZ9999')).toBe('g4321-ZZZZ9999');
            // No portable identity (feed, unregistered group): the numeric id is
            // the documented fallback, not an error.
            expect(snapshotNoteId(42, 'ZZZZ9999')).toBe('42-ZZZZ9999');
        } finally {
            (globalThis as any).Zotero = prevZotero;
        }
    });

    it('falls back to the numeric library id when Zotero cannot resolve a ref', () => {
        expect(snapshotNoteId(1, 'ABCD1234')).toBe('1-ABCD1234');
    });

    it('is stable for the same note and content', () => {
        expect(buildAddressSnapshot(NOTE_A, simplified))
            .toBe(buildAddressSnapshot(NOTE_A, simplified));
    });

    it('changes when the content changes', () => {
        const edited = note('<h1>Title</h1>', '<p>First para EDITED</p>', '<p>Second para</p>');
        expect(buildAddressSnapshot(NOTE_A, edited))
            .not.toBe(buildAddressSnapshot(NOTE_A, simplified));
    });

    it('changes for equal-length differing content (the digest is doing work)', () => {
        const swapped = note('<h1>Title</h1>', '<p>Frist para</p>', '<p>Second para</p>');
        expect(swapped).toHaveLength(simplified.length);
        expect(swapped).not.toBe(simplified);
        const a = buildAddressSnapshot(NOTE_A, simplified);
        const b = buildAddressSnapshot(NOTE_A, swapped);
        // Same length term, different digest.
        expect(a.split(':')[2]).toBe(b.split(':')[2]);
        expect(a).not.toBe(b);
    });

    // THE REASON THE NOTE ID IS IN THE DIGEST. Without it the token identifies a
    // string rather than a note, so two notes that happen to read identically —
    // a duplicate, a note from a template — would accept each other's tokens.
    it('changes when only the note identity changes', () => {
        expect(buildAddressSnapshot(NOTE_A, simplified))
            .not.toBe(buildAddressSnapshot(NOTE_B, simplified));
    });

    it('refuses a token issued for a DIFFERENT note with identical content', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        expect(addressable(token, NOTE_A, simplified)).toBe(true);
        expect(addressable(token, NOTE_B, simplified)).toBe(false);
    });

    it('distinguishes the same key in different libraries', () => {
        expect(buildAddressSnapshot(snapshotNoteId(1, 'ABCD1234'), simplified))
            .not.toBe(buildAddressSnapshot(snapshotNoteId(2, 'ABCD1234'), simplified));
    });

    it('accepts a well-formed token structurally', () => {
        expect(isAddressSnapshotToken(buildAddressSnapshot(NOTE_A, simplified))).toBe(true);
    });

    it('rejects malformed tokens structurally', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        const [, digest, length, unmasked] = token.split(':');
        expect(isAddressSnapshotToken('')).toBe(false);
        expect(isAddressSnapshotToken('garbage')).toBe(false);
        expect(isAddressSnapshotToken(`x:${digest}:${length}:${unmasked}`)).toBe(false);       // wrong prefix
        expect(isAddressSnapshotToken(`h2:${digest}:${length}`)).toBe(false);                  // missing lane
        expect(isAddressSnapshotToken(`h2:${digest}:${length}:${unmasked}:1-3`)).toBe(false);  // extra part
        expect(isAddressSnapshotToken(`h2:nothex:${length}:${unmasked}`)).toBe(false);         // bad digest
        expect(isAddressSnapshotToken(`h2:${digest.slice(1)}:${length}:${unmasked}`)).toBe(false); // short digest
        expect(isAddressSnapshotToken(`h2:${digest}:${length}:nothex`)).toBe(false);           // bad second lane
        expect(isAddressSnapshotToken(`h2:${digest}:ten:${unmasked}`)).toBe(false);            // bad length
        expect(isAddressSnapshotToken(`h2:${digest}:-1:${unmasked}`)).toBe(false);             // negative length
        expect(isAddressSnapshotToken(`h2:${digest}:1.5:${unmasked}`)).toBe(false);            // fractional length
        expect(isAddressSnapshotToken(`h2:${digest}: 10:${unmasked}`)).toBe(false);            // whitespace
    });

    // The old format carried a trailing `<from>-<to>` read window. A token from
    // that era must not verify — its digest was over different input anyway, but
    // failing structurally first gives the clearer error.
    it('rejects the retired window-bearing token form', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        expect(isAddressSnapshotToken(`${token}:1-3`)).toBe(false);
        expect(addressable(`${token}:1-3`, NOTE_A, simplified)).toBe(false);
    });

    // A single-lane `h:` token cannot say whether locators drifted, so accepting
    // one would silently reopen the hole the second lane closes. It must fail
    // STRUCTURALLY (→ `snapshot_malformed`), not as a mismatch: a fresh listing
    // cannot fix it, only a fresh read can.
    it('rejects a single-lane token from an older build', () => {
        const parts = buildAddressSnapshot(NOTE_A, simplified).split(':');
        const legacy = `h:${parts[1]}:${parts[2]}`;
        expect(isAddressSnapshotToken(legacy)).toBe(false);
        expect(checkAddressSnapshot(legacy, NOTE_A, simplified)).toBe('malformed');
    });

    it('verifies an unmodified token against its own note', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        expect(addressable(token, NOTE_A, simplified)).toBe(true);
    });

    it('fails verification when the note changed underneath the token', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        const edited = note('<h1>Title</h1>', '<p>First para</p>', '<p>Second para (edited)</p>');
        expect(addressable(token, NOTE_A, edited)).toBe(false);
    });

    it('fails verification on garbage', () => {
        expect(addressable('', NOTE_A, simplified)).toBe(false);
        expect(addressable('h2:deadbeefdeadbeef:12:deadbeefdeadbeef', NOTE_A, simplified))
            .toBe(false);
    });

    it('fails verification when the length term was tampered with', () => {
        const parts = buildAddressSnapshot(NOTE_A, simplified).split(':');
        const tampered = [parts[0], parts[1], String(Number(parts[2]) + 1), parts[3]].join(':');
        expect(addressable(tampered, NOTE_A, simplified)).toBe(false);
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
        const token = buildAddressSnapshot(NOTE_A, read);
        expect(addressable(token, NOTE_A, laterWithDriftedLabels)).toBe(true);
    });

    it('still fails when real content changed alongside locator drift', () => {
        const read = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const later = note('<p>Claim REWRITTEN ' + citation('1-ABCD1234', 'page17') + '</p>');
        const token = buildAddressSnapshot(NOTE_A, read);
        expect(addressable(token, NOTE_A, later)).toBe(false);
    });

    // ── checkAddressSnapshot: the three-way verdict ─────────────────────────
    //
    // `addressable()` above answers only "can these block numbers still be
    // resolved". The verdict below is what the blocks path acts on, because the
    // answer to "is a locator difference the model's doing?" is different in
    // each of the three reachable states.

    it('reports match for an untouched note', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        expect(checkAddressSnapshot(token, NOTE_A, simplified)).toBe('match');
    });

    it('reports locator_drift when only citation locators moved', () => {
        const read = note(
            '<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>',
            '<p>Both ' + compoundCitation('1-AAAA1111:page=3, 1-BBBB2222:page=9') + '</p>',
        );
        const drifted = note(
            '<p>Claim ' + citation('1-ABCD1234', 'page17') + '</p>',
            '<p>Both ' + compoundCitation('1-AAAA1111:page=xii, 1-BBBB2222:page=101') + '</p>',
        );
        const token = buildAddressSnapshot(NOTE_A, read);
        expect(checkAddressSnapshot(token, NOTE_A, drifted)).toBe('locator_drift');
        // …and the numbering is still good, which is why validation proceeds.
        expect(addressable(token, NOTE_A, drifted)).toBe(true);
    });

    it('reports mismatch when the note itself changed, drift or no drift', () => {
        const read = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const token = buildAddressSnapshot(NOTE_A, read);
        expect(checkAddressSnapshot(token, NOTE_A, note('<p>Claim REWRITTEN ' + citation('1-ABCD1234', 'page3') + '</p>')))
            .toBe('mismatch');
        expect(checkAddressSnapshot(token, NOTE_A, note('<p>Claim REWRITTEN ' + citation('1-ABCD1234', 'page17') + '</p>')))
            .toBe('mismatch');
    });

    // The note id is inside BOTH lanes, so a token echoed from another note is a
    // mismatch — never a drift report about a note it was never minted for.
    it('reports mismatch for a token minted against a different note', () => {
        const withLocator = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const token = buildAddressSnapshot(NOTE_B, withLocator);
        expect(checkAddressSnapshot(token, NOTE_A, withLocator)).toBe('mismatch');
    });

    it('reports malformed for garbage', () => {
        expect(checkAddressSnapshot('', NOTE_A, simplified)).toBe('malformed');
        expect(checkAddressSnapshot('garbage', NOTE_A, simplified)).toBe('malformed');
    });

    // This module has no notion of a displayed range — the decision to withhold
    // a token after a PARTIAL read lives in handleReadNoteRequest, which is
    // where it is tested. What belongs here is that the digest is defined over
    // the whole projection, so a slice of it never verifies.
    it('is defined over the whole projection, never over a slice of it', () => {
        const whole = note(...Array.from({ length: 300 }, (_, i) => `<p>Line ${i + 1}</p>`));
        const token = buildAddressSnapshot(NOTE_A, whole);

        expect(addressable(token, NOTE_A, whole)).toBe(true);
        const firstFifty = whole.split('\n').slice(0, 50).join('\n');
        expect(addressable(token, NOTE_A, firstFifty)).toBe(false);
    });
});
