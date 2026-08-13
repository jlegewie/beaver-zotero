/**
 * Address snapshot tokens for block-numbered note editing.
 *
 * `read_note` renders a simplified projection of a note and numbers its lines;
 * `edit_note_blocks` then addresses those lines BY NUMBER. That only works if
 * both sides agree on which string was numbered, so every response that shows
 * blocks the model can address issues a snapshot token pinning it, and every
 * edit that addresses by number echoes the token back. This module is the single
 * implementation of both directions — build and verify — so producer and
 * comparator cannot drift.
 *
 * Token format (see `WSReadNoteResponse.snapshot` for the wire contract):
 *
 *     'h3:' + <digest> + ':' + <length>
 *
 * The token is a NOTE VERSION IDENTIFIER and nothing more: it answers "is this
 * the same note, in the same state, that produced the numbering you are
 * addressing?" Two design points worth stating explicitly, because each one is
 * load-bearing and neither is obvious from the format alone:
 *
 * 1. WHY THE NOTE ID IS INSIDE THE DIGEST. Without it the token identifies a
 *    STRING, not a note, so a token issued for note A verifies against any note
 *    B whose simplified projection happens to be identical — duplicated notes and
 *    template notes make that reachable. The pre-flight that refuses a numeric
 *    address without a token exists to enforce "you read THIS note first", and
 *    binding the id is what makes that true rather than merely likely.
 *
 * 2. WHY 64 BITS IS ENOUGH. The digest is a non-cryptographic hash and a
 *    collision would let a changed note verify against a stale token. That risk
 *    is accepted deliberately: it is astronomically less likely than the failure
 *    mode no digest can catch — a model mis-deriving a block number from a note
 *    it read correctly. The real guards are the snapshot-required pre-flight
 *    (an edit addressing by number without a token is refused outright) and the
 *    rule that a token is only ever issued alongside the whole listing it
 *    addresses; the digest only has to catch honest staleness.
 *
 * THERE IS NO READ WINDOW IN THE TOKEN. "Is the numbering current?" and "was the
 * model shown what it is addressing?" are two questions, and they get two
 * mechanisms rather than one:
 *
 *   - "is the numbering current?" — the digest, which covers the WHOLE note
 *     however little of it was displayed. That is what makes the token a note
 *     VERSION identifier, and it is why the same token survives an edit set that
 *     spans anything the reader was shown.
 *   - "was the model shown what it is addressing?" — answered by WITHHOLDING
 *     the token entirely, not by qualifying it. `read_note` issues a snapshot
 *     only for a whole-note read; a paged read gets content and no token. The
 *     backend applies the same rule to its own payloads, dropping the snapshot
 *     whenever it drops the listing that snapshot addresses.
 *
 * The second bullet is load-bearing and easy to get wrong, so state the reason
 * plainly: `expect` cannot stand in for it. Over half a typical note's lines
 * carry no visible text and are confirmed only by their attribute-stripped tag,
 * so one `</ul>` confirms every other `</ul>` in the note; and a ranged `delete`
 * confirms only its two endpoints, never its interior. `expect` is a per-block
 * sanity check, not an addressing guard — see `matchExpect` in
 * `editNoteBlocksCore.ts`, which says so at its definition.
 *
 * No React-bundle imports, no async: this module is imported from the no-await
 * critical section around a note read, so everything here is synchronous and
 * allocation-light. Hashing and verification are pure string work; the one
 * exception is {@link snapshotNoteId}, which resolves a portable library
 * identity through `libraryIdentity` (sync, best-effort, never throws).
 */

import { libraryRefForLibraryID } from './libraryIdentity';

// =============================================================================
// Digest
// =============================================================================

// Two independent 32-bit lanes with different seeds and multipliers. Run in one
// pass over the input because two passes would read the string twice for no
// added independence.
const LANE_A_SEED = 0x811c9dc5 | 0;
const LANE_A_PRIME = 0x01000193;
const LANE_B_SEED = 0xcbf29ce4 | 0;
const LANE_B_PRIME = 0x85ebca6b;

/** Number of hex characters each 32-bit lane contributes. */
const LANE_HEX_WIDTH = 8;
/** Total digest width: two lanes of {@link LANE_HEX_WIDTH} hex chars. */
const DIGEST_HEX_WIDTH = LANE_HEX_WIDTH * 2;

/**
 * 64-bit non-cryptographic digest, emitted as 16 lowercase hex characters.
 *
 * Drift detection only — NOT a security boundary, so no SHA-256 (which would
 * also be async in this environment). Two independent 32-bit FNV-style lanes,
 * each with its own seed and multiplier, are computed in a single pass and
 * concatenated as fixed-width unsigned hex; deliberately no BigInt, since two
 * 32-bit lanes are the whole point and BigInt would only be slower.
 *
 * The output contains hex digits only — no `:` — which is what makes the
 * snapshot token splittable on `:` unambiguously.
 */
export function quickHash64(input: string): string {
    let a = LANE_A_SEED;
    let b = LANE_B_SEED;
    for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        a = Math.imul(a ^ c, LANE_A_PRIME);
        b = Math.imul(b ^ c, LANE_B_PRIME);
        // Rotate lane B so the two lanes diverge on input ORDER as well as on
        // their multipliers.
        b = (b << 13) | (b >>> 19);
    }
    // Final avalanche so short inputs differing in one character don't produce
    // digests that differ only in their low bits.
    a ^= a >>> 15;
    a = Math.imul(a, 0x2545f491);
    a ^= a >>> 13;
    b ^= b >>> 16;
    b = Math.imul(b, 0x27d4eb2f);
    b ^= b >>> 15;
    return (
        (a >>> 0).toString(16).padStart(LANE_HEX_WIDTH, '0')
        + (b >>> 0).toString(16).padStart(LANE_HEX_WIDTH, '0')
    );
}

// =============================================================================
// Snapshot token
// =============================================================================

/**
 * Prefix identifying a hash-form address snapshot token.
 *
 * VERSIONED. A token minted by an older build digests a different input, so
 * comparing it against a token minted today would answer a question nobody
 * asked — it must not be accepted as if it described this note. It fails
 * {@link isAddressSnapshotToken} on the prefix and lands on the
 * `snapshot_malformed` path, which tells the model to re-read.
 *
 * No compatibility branch reads an older form, and none should be added:
 * `edit_note_blocks` has not shipped, so the only older-format tokens that ever
 * existed are in development threads. A format change made once the tool faces
 * a real installed base is a different decision.
 */
const TOKEN_PREFIX = 'h3';
/** Number of `:`-separated parts in a well-formed token. */
const TOKEN_PARTS = 3;

const DIGEST_RE = new RegExp(`^[0-9a-f]{${DIGEST_HEX_WIDTH}}$`);
/** A non-negative decimal integer. Rejects signs, points, exponents, spaces. */
const LENGTH_RE = /^\d+$/;

/**
 * The note identity folded into every digest.
 *
 * Build it from the RESOLVED Zotero item (`item.libraryID` / `item.key`), never
 * from a request field the caller has not resolved: a portable `u-KEY` id and a
 * legacy numeric id name the same note and must produce the same token. This is
 * also the simplification cache key, and the two must not drift apart.
 *
 * PORTABLE, NOT DEVICE-LOCAL. The library part is the `library_ref` form
 * (`u` / `g<groupID>`), the same one `modelObjectId` emits, because a
 * token does not stay on the device that minted it: it travels in the thread
 * transcript, and a thread can be resumed — or an approval executed — on
 * another Zotero instance. A group library's `libraryID` is assigned per
 * device, so binding it would fail a byte-identical note read on a laptop and
 * edited on a desktop, with a "snapshot does not match this note" refusal the
 * user cannot act on. `libraryRefForLibraryID` is best-effort by design and
 * falls back to the numeric id for a library with no portable identity (feeds,
 * the external-file sentinel, an unregistered group) — device-local again, but
 * only for libraries a cross-device thread cannot reach anyway.
 */
export function snapshotNoteId(libraryId: number, itemKey: string): string {
    return `${libraryRefForLibraryID(libraryId) ?? libraryId}-${itemKey}`;
}

/**
 * Build the address snapshot token for a note and its simplified projection.
 *
 * `simplified` must be the EXACT string whose `split('\n')` defines the block
 * numbering the recipient will see — not a numbered rendering of it, and not a
 * paginated slice.
 *
 * CALLING THIS DOES NOT MEAN THE TOKEN SHOULD BE SENT. The digest covers the
 * whole note, so a caller that displayed only part of it must withhold the
 * result — see `handleReadNoteRequest`, which builds a token only when the
 * response showed every line.
 *
 * `noteId` must come from {@link snapshotNoteId}.
 */
export function buildAddressSnapshot(noteId: string, simplified: string): string {
    return `${TOKEN_PREFIX}:${quickHash64(`${noteId}|${simplified}`)}:${simplified.length}`;
}

/**
 * Structurally check a snapshot token WITHOUT checking it against a note.
 *
 * Validates the `h3:` prefix, the digest term and the length term; returns false
 * on anything malformed, INCLUDING a well-formed token of an older format (see
 * {@link TOKEN_PREFIX}). Useful for cheap pre-flight rejection (e.g. an edit
 * request carrying obvious garbage) — but it proves nothing about the note.
 * Anything that is about to act on block numbers must use
 * {@link checkAddressSnapshot}.
 */
export function isAddressSnapshotToken(token: string): boolean {
    if (typeof token !== 'string') return false;
    const parts = token.split(':');
    if (parts.length !== TOKEN_PARTS) return false;
    if (parts[0] !== TOKEN_PREFIX) return false;
    if (!DIGEST_RE.test(parts[1])) return false;
    return LENGTH_RE.test(parts[2]);
}

/**
 * What a snapshot token says about the note it is being checked against.
 *
 * - `match` — the projection is byte-identical to the one that minted the token.
 * - `mismatch` — the numbering the token pins is gone, or the token was minted
 *   for a different note. The two are indistinguishable here by design.
 * - `malformed` — not a token of the current format at all; no note state can
 *   make it verify.
 */
export type AddressSnapshotStatus = 'match' | 'mismatch' | 'malformed';

/**
 * Check a snapshot token against a note and its simplified projection.
 *
 * RECOMPUTES the token — the note id participates, so a token issued for a
 * different note fails even when the two notes read identically.
 */
export function checkAddressSnapshot(
    token: string,
    noteId: string,
    simplified: string,
): AddressSnapshotStatus {
    if (!isAddressSnapshotToken(token)) return 'malformed';
    return buildAddressSnapshot(noteId, simplified) === token ? 'match' : 'mismatch';
}
