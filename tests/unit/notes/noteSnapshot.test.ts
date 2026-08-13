import { describe, it, expect } from 'vitest';
import {
    quickHash64,
    snapshotNoteId,
    buildAddressSnapshot,
    checkAddressSnapshot,
    isAddressSnapshotToken,
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

/** "Do these block numbers still resolve?" — only `match` says they do. */
function addressable(token: string, noteId: string, simplified: string): boolean {
    return checkAddressSnapshot(token, noteId, simplified) === 'match';
}

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

    it('has the documented three-part shape', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        const parts = token.split(':');
        expect(parts).toHaveLength(3);
        expect(parts[0]).toBe('h3');
        expect(parts[1]).toMatch(/^[0-9a-f]{16}$/);
        expect(parts[2]).toBe(String(simplified.length));
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
        const [, digest, length] = token.split(':');
        expect(isAddressSnapshotToken('')).toBe(false);
        expect(isAddressSnapshotToken('garbage')).toBe(false);
        expect(isAddressSnapshotToken(`x:${digest}:${length}`)).toBe(false);            // wrong prefix
        expect(isAddressSnapshotToken(`h3:${digest}`)).toBe(false);                     // missing length
        expect(isAddressSnapshotToken(`h3:${digest}:${length}:${digest}`)).toBe(false); // extra part
        expect(isAddressSnapshotToken(`h3:nothex:${length}`)).toBe(false);              // bad digest
        expect(isAddressSnapshotToken(`h3:${digest.slice(1)}:${length}`)).toBe(false);  // short digest
        expect(isAddressSnapshotToken(`h3:${digest}:ten`)).toBe(false);                 // bad length
        expect(isAddressSnapshotToken(`h3:${digest}:-1`)).toBe(false);                  // negative length
        expect(isAddressSnapshotToken(`h3:${digest}:1.5`)).toBe(false);                 // fractional length
        expect(isAddressSnapshotToken(`h3:${digest}: 10`)).toBe(false);                 // whitespace
    });

    // A token from an older build digests a different input, so accepting one
    // would compare two strings that were never comparable. It must fail
    // STRUCTURALLY (→ `snapshot_malformed`), not as a mismatch: a fresh listing
    // cannot fix it, only a fresh read can.
    it.each([
        ['a window-bearing form', (d: string, l: string) => `h:${d}:${l}:1-3`],
        ['a two-digest form', (d: string, l: string) => `h2:${d}:${l}:${d}`],
    ])('rejects %s minted by an older build', (_label, build) => {
        const [, digest, length] = buildAddressSnapshot(NOTE_A, simplified).split(':');
        const legacy = build(digest, length);
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
        expect(addressable('h3:deadbeefdeadbeef:12', NOTE_A, simplified)).toBe(false);
    });

    it('fails verification when the length term was tampered with', () => {
        const parts = buildAddressSnapshot(NOTE_A, simplified).split(':');
        const tampered = [parts[0], parts[1], String(Number(parts[2]) + 1)].join(':');
        expect(addressable(tampered, NOTE_A, simplified)).toBe(false);
    });

    // A citation locator is projected exactly as the note stores it, so a
    // locator that reads differently means the note itself reads differently —
    // and the token says so, like any other content change.
    it('fails verification when a citation locator changed', () => {
        const read = note(
            '<h1>Title</h1>',
            '<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>',
            '<p>Both ' + compoundCitation('1-AAAA1111:page=3, 1-BBBB2222:page=9') + '</p>',
        );
        const later = note(
            '<h1>Title</h1>',
            '<p>Claim ' + citation('1-ABCD1234', 'page17') + '</p>',
            '<p>Both ' + compoundCitation('1-AAAA1111:page=xii, 1-BBBB2222:page=101') + '</p>',
        );
        expect(read).not.toBe(later);
        const token = buildAddressSnapshot(NOTE_A, read);
        expect(checkAddressSnapshot(token, NOTE_A, later)).toBe('mismatch');
    });

    it('fails when real content changed alongside a locator', () => {
        const read = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const later = note('<p>Claim REWRITTEN ' + citation('1-ABCD1234', 'page17') + '</p>');
        const token = buildAddressSnapshot(NOTE_A, read);
        expect(addressable(token, NOTE_A, later)).toBe(false);
    });

    // ── checkAddressSnapshot: the verdict ───────────────────────────────────

    it('reports match for an untouched note', () => {
        const token = buildAddressSnapshot(NOTE_A, simplified);
        expect(checkAddressSnapshot(token, NOTE_A, simplified)).toBe('match');
    });

    it('reports mismatch when the note itself changed', () => {
        const read = note('<p>Claim ' + citation('1-ABCD1234', 'page3') + '</p>');
        const token = buildAddressSnapshot(NOTE_A, read);
        expect(checkAddressSnapshot(token, NOTE_A, note('<p>Claim REWRITTEN ' + citation('1-ABCD1234', 'page3') + '</p>')))
            .toBe('mismatch');
    });

    // The note id is inside the digest, so a token echoed from another note is a
    // mismatch rather than a verdict about a note it was never minted for.
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
