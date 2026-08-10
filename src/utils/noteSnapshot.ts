/**
 * Address snapshot tokens for block-numbered note editing.
 *
 * `read_note` renders a simplified projection of a note and numbers its lines;
 * `edit_note_blocks` then addresses those lines BY NUMBER. That only works if
 * both sides agree on which string was numbered, so every response that shows
 * blocks issues a snapshot token pinning it, and every edit that addresses by
 * number echoes the token back. This module is the single implementation of
 * both directions — build and verify — so producer and comparator cannot drift.
 *
 * Token format (see `WSReadNoteResponse.snapshot` for the wire contract):
 *
 *     'h:' + <digest> + ':' + <length> + ':' + <from> + '-' + <to>
 *
 * Three design points worth stating explicitly, because each one is load-bearing
 * and none is obvious from the format alone:
 *
 * 1. WHY MASKING. Citation locators are rendered from page-label caches that
 *    populate asynchronously and can change between a read and a later edit
 *    (`loc="page3"` becoming `loc="page17"` for the very same citation). That
 *    drift changes ATTRIBUTE VALUES only — never line counts, never block
 *    numbering — so treating it as a note change would false-fail edits that are
 *    perfectly well addressed. {@link maskVolatileLocators} removes exactly that
 *    class of drift from the digest input, and nothing else.
 *
 * 2. WHY THE WINDOW IS INSIDE THE DIGEST. The trailing `<from>-<to>` records
 *    what was actually SHOWN to the model, and the edit engine refuses numeric
 *    addresses outside it. If the window were merely appended, a model could
 *    widen `:1-100` to `:1-9999` and license itself to edit blocks it never saw.
 *    Folding the window into the hashed input makes any such rewrite produce a
 *    token that no longer verifies, so a hand-widened window routes into
 *    snapshot-mismatch recovery instead of a blind edit.
 *
 * 3. WHY 64 BITS IS ENOUGH. The digest is a non-cryptographic hash and a
 *    collision would let a changed note verify against a stale token. That risk
 *    is accepted deliberately: it is astronomically less likely than the failure
 *    mode no digest can catch — a model mis-deriving a block number from a note
 *    it read correctly. The real guards are the snapshot-required pre-flight
 *    (an edit addressing by number without a token is refused outright) and the
 *    window binding above; the digest only has to catch honest staleness.
 *
 * Pure module: no `Zotero.*`, no React-bundle imports, no async. It is imported
 * from the no-await critical section around a note read, so everything here is
 * synchronous and allocation-light.
 */

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
// Read window
// =============================================================================

/**
 * The inclusive 1-based range of blocks a response actually SHOWED.
 *
 * It is what was shown, not what was asked for or what the note contains: an
 * edit addressing a block outside this window is refused with
 * `address_outside_read_window`.
 */
export interface ReadWindow {
    /** First block shown (1-based, inclusive). `0` only in the empty window. */
    from: number;
    /** Last block shown (1-based, inclusive). `0` only in the empty window. */
    to: number;
}

/**
 * The canonical "nothing was shown" window.
 *
 * Builder and validator MUST agree on this literal byte-for-byte — it is part
 * of the digest input, and it is what a response that ships a token WITHOUT the
 * note body carries, so every numeric address against it fails closed until the
 * model re-reads. (`op: 'rewrite'` needs no window and stays available.)
 */
export const EMPTY_READ_WINDOW: ReadWindow = Object.freeze({ from: 0, to: 0 });

/** Serialize a read window to its canonical `<from>-<to>` form. */
export function encodeReadWindow(w: ReadWindow): string {
    return `${w.from}-${w.to}`;
}

/** Parse a non-negative decimal integer, or `null`. Rejects signs, decimal
 *  points, exponents, whitespace, and anything else `Number()` would coerce. */
function parseNonNegativeInt(s: string): number | null {
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a `<from>-<to>` read window. FAILS CLOSED — returns `null` rather than
 * guessing — on a missing `-`, non-numeric or non-integer parts, negative
 * numbers, and any inverted window (`from > to`).
 *
 * The canonical empty window `0-0` parses successfully: it has `from === to`,
 * so it is not inverted and needs no special case.
 */
export function parseReadWindow(s: string): ReadWindow | null {
    if (typeof s !== 'string') return null;
    const sep = s.indexOf('-');
    // `sep === 0` means a leading `-`, i.e. a negative `from`.
    if (sep <= 0) return null;
    const from = parseNonNegativeInt(s.slice(0, sep));
    const to = parseNonNegativeInt(s.slice(sep + 1));
    if (from === null || to === null) return null;
    if (from > to) return null;
    return { from, to };
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
const TOKEN_PARTS = 4;

const DIGEST_RE = new RegExp(`^[0-9a-f]{${DIGEST_HEX_WIDTH}}$`);

/**
 * Build the address snapshot token for a simplified note projection and the
 * window that was actually shown.
 *
 * `simplified` must be the EXACT string whose `split('\n')` defines the block
 * numbering the recipient will see — not a numbered rendering of it, and not a
 * paginated slice.
 *
 * The window participates in the digest, not just in the suffix: see this
 * module's header for why that is what stops a model from widening its own
 * addressing licence.
 *
 * THROWS on a window {@link parseReadWindow} would refuse. Without this a caller
 * could mint a structurally invalid token (`1-0` from an off-by-one on an empty
 * slice) that its own {@link verifyAddressSnapshot} then rejects against the
 * very note it was built from — an unexplainable permanent mismatch. It is a
 * programming error, not a data condition, so it fails loudly at the source.
 */
export function buildAddressSnapshot(simplified: string, window: ReadWindow): string {
    if (!parseReadWindow(encodeReadWindow(window))) {
        throw new Error(
            `buildAddressSnapshot: invalid read window ${encodeReadWindow(window)}; `
            + 'expected 0-0 (nothing shown) or from <= to with non-negative integers.',
        );
    }
    const masked = maskVolatileLocators(simplified);
    const encodedWindow = encodeReadWindow(window);
    const digest = quickHash64(`${masked}|${encodedWindow}`);
    return `${TOKEN_PREFIX}:${digest}:${masked.length}:${encodedWindow}`;
}

/** A structurally valid snapshot token and the window it carries. */
export interface ParsedAddressSnapshot {
    /** The token exactly as supplied. */
    token: string;
    /** The read window parsed out of the token's suffix. */
    window: ReadWindow;
}

/**
 * Structurally parse a snapshot token WITHOUT checking it against a note.
 *
 * Validates the `h:` prefix, the digest shape, the length term and the window;
 * returns `null` on anything malformed. Useful for cheap pre-flight rejection
 * (e.g. an edit request carrying obvious garbage) — but it proves nothing about
 * the note. Anything that is about to act on block numbers must use
 * {@link verifyAddressSnapshot}.
 */
export function parseAddressSnapshot(token: string): ParsedAddressSnapshot | null {
    if (typeof token !== 'string') return null;
    const parts = token.split(':');
    if (parts.length !== TOKEN_PARTS) return null;
    if (parts[0] !== TOKEN_PREFIX) return null;
    if (!DIGEST_RE.test(parts[1])) return null;
    if (parseNonNegativeInt(parts[2]) === null) return null;
    const window = parseReadWindow(parts[3]);
    if (!window) return null;
    return { token, window };
}

/**
 * Verify a snapshot token against a simplified note projection.
 *
 * Parses the token, RECOMPUTES it from `simplified` using the window parsed out
 * of the token itself, and requires byte equality. Returns the verified window
 * on success and `null` on any mismatch or malformed token.
 *
 * This is the function callers use. It is deliberately impossible to check the
 * digest without also receiving the window: the two travel together, so no
 * caller can validate staleness and then forget to bound the addressing.
 */
export function verifyAddressSnapshot(token: string, simplified: string): ReadWindow | null {
    const parsed = parseAddressSnapshot(token);
    if (!parsed) return null;
    const recomputed = buildAddressSnapshot(simplified, parsed.window);
    return recomputed === token ? parsed.window : null;
}
