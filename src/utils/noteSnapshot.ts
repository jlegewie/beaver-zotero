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
 *     'h:' + <digest> + ':' + <length>
 *
 * The token is a NOTE VERSION IDENTIFIER and nothing more: it answers "is this
 * the same note, in the same state, that produced the numbering you are
 * addressing?" Three design points worth stating explicitly, because each one is
 * load-bearing and none is obvious from the format alone:
 *
 * 1. WHY MASKING. Citation locators are rendered from page-label caches that
 *    populate asynchronously and can change between a read and a later edit
 *    (`loc="page3"` becoming `loc="page17"` for the very same citation). That
 *    drift changes ATTRIBUTE VALUES only — never line counts, never block
 *    numbering — so treating it as a note change would false-fail edits that are
 *    perfectly well addressed. {@link maskVolatileLocators} removes exactly that
 *    class of drift from the digest input, and nothing else.
 *
 * 2. WHY THE NOTE ID IS INSIDE THE DIGEST. Without it the token identifies a
 *    STRING, not a note, so a token issued for note A verifies against any note
 *    B whose simplified projection happens to be identical — duplicated notes and
 *    template notes make that reachable. The pre-flight that refuses a numeric
 *    address without a token exists to enforce "you read THIS note first", and
 *    binding the id is what makes that true rather than merely likely.
 *
 * 3. WHY 64 BITS IS ENOUGH. The digest is a non-cryptographic hash and a
 *    collision would let a changed note verify against a stale token. That risk
 *    is accepted deliberately: it is astronomically less likely than the failure
 *    mode no digest can catch — a model mis-deriving a block number from a note
 *    it read correctly. The real guards are the snapshot-required pre-flight
 *    (an edit addressing by number without a token is refused outright) and the
 *    rule that a token is only ever issued alongside the whole listing it
 *    addresses; the digest only has to catch honest staleness.
 *
 * THERE IS NO READ WINDOW IN THE TOKEN. An earlier revision folded the range a
 * response had actually SHOWN into the token and refused numeric addresses
 * outside it. That answered two different questions with one mechanism, and the
 * two are now separated:
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
 * allocation-light. Masking, hashing and verification are pure string work; the
 * one exception is {@link snapshotNoteId}, which resolves a portable library
 * identity through `libraryIdentity` (sync, best-effort, never throws).
 */

import { libraryRefForLibraryID } from './libraryIdentity';

// =============================================================================
// Locator masking
// =============================================================================

/**
 * Replacement for a masked locator value.
 *
 * Contains a NUL (written as an escape so no literal control byte lands in
 * source), which cannot occur in note HTML — so a masked value can never be
 * confused with real content. Being fixed-width, it also makes the token's
 * `<length>` term stable across locator drift: `page3` and `page17` mask to the
 * same thing.
 */
const LOCATOR_MASK = '\u0000L';

// A self-closing simplified citation tag: `<citation … />`. Attribute values are
// escaped by `escapeAttr` (which encodes `>` as `&gt;`), so `[^>]*` cannot run
// past the tag it started in.
const CITATION_TAG_RE = /<citation\b[^>]*\/>/g;

// `loc="…"` / `page="…"` on a citation tag. The leading whitespace requirement
// keeps this from matching a suffix of some other attribute name.
const CITATION_LOCATOR_ATTR_RE = /(\s(?:loc|page)=")[^"]*"/g;

// A `:page=<value>` suffix inside a compound `items="A:page=3, B:page=9"` value.
//
// The compound value joins entries with `, `, so a naive "stop at the first
// comma" rule half-masks a locator that itself contains commas — and locators
// legitimately do (`pageLabelTranslation` splits on `[-–,]`, so `page=12, 15` is
// one drifting locator, not a locator plus an item). Half-masking leaves live
// drift in the digest and produces spurious snapshot mismatches.
//
// So the run continues across a comma UNLESS that comma introduces a new item
// reference: an id (`u-KEY` / `g12-KEY` / `5-KEY`) followed by `:page=`, another
// comma, or the end of the attribute value.
const NEW_ITEM_REF_AHEAD = String.raw`(?!\s*[A-Za-z0-9]+-[A-Za-z0-9]+(?=:page=|,|"|$))`;
const COMPOUND_LOCATOR_RE = new RegExp(
    String.raw`:page=[^,"]*(?:,${NEW_ITEM_REF_AHEAD}[^,"]*)*`,
    'g',
);

/**
 * Mask the volatile locator values inside simplified note HTML.
 *
 * Page-label caches drift between a read and a later edit, changing citation
 * locator values without changing a single line boundary. Masking them keeps
 * that drift out of the address snapshot, so an edit written against a correctly
 * read note is not rejected because a page label resolved differently in the
 * meantime.
 *
 * Exactly two things are masked, both scoped to self-closing `<citation …/>`
 * tags:
 *
 * 1. the values of `loc="…"` and `page="…"`;
 * 2. the `:page=<value>` locator suffixes inside a compound `items="…"` value.
 *
 * Everything else survives verbatim — in particular:
 *
 * - `page="…"` on an `<annotation …>` tag is NOT a citation locator (it is the
 *   annotation's own recorded page and does not drift with label caches), so it
 *   is left alone;
 * - the item ids inside `items="…"` are identity, not locators, and are left
 *   alone: changing one changes the mask output, as it must.
 *
 * Only attribute VALUES are replaced; names and quotes stay in place so masked
 * output remains legible when it shows up in a debug log.
 */
export function maskVolatileLocators(simplified: string): string {
    // Cheap bail-out: notes without citations are the common case.
    if (simplified.indexOf('<citation') === -1) return simplified;
    return simplified.replace(CITATION_TAG_RE, (tag) =>
        tag
            .replace(CITATION_LOCATOR_ATTR_RE, `$1${LOCATOR_MASK}"`)
            .replace(COMPOUND_LOCATOR_RE, `:page=${LOCATOR_MASK}`),
    );
}

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

/** Prefix identifying a hash-form address snapshot token. */
const TOKEN_PREFIX = 'h';
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
    const masked = maskVolatileLocators(simplified);
    const digest = quickHash64(`${noteId}|${masked}`);
    return `${TOKEN_PREFIX}:${digest}:${masked.length}`;
}

/**
 * Structurally check a snapshot token WITHOUT checking it against a note.
 *
 * Validates the `h:` prefix, the digest shape and the length term; returns false
 * on anything malformed. Useful for cheap pre-flight rejection (e.g. an edit
 * request carrying obvious garbage) — but it proves nothing about the note.
 * Anything that is about to act on block numbers must use
 * {@link verifyAddressSnapshot}.
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
 * Verify a snapshot token against a note and its simplified projection.
 *
 * RECOMPUTES the token and requires byte equality — the note id participates, so
 * a token issued for a different note fails even when the two notes read
 * identically. Returns false on any mismatch or malformed token.
 */
export function verifyAddressSnapshot(
    token: string,
    noteId: string,
    simplified: string,
): boolean {
    if (!isAddressSnapshotToken(token)) return false;
    return buildAddressSnapshot(noteId, simplified) === token;
}
