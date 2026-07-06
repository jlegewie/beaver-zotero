/**
 * Live tests for the device-portable library-identity resolvers in
 * `src/utils/libraryIdentity.ts`, exercised against the connected Zotero's real
 * personal + group libraries through the dev-only `/beaver/test/library-identity`
 * endpoint.
 *
 * Covers:
 *   - libraryRefForLibraryID: personal -> "u", group -> "g<groupID>", the
 *     external-file sentinel (-1) -> null, and an unknown library id -> null.
 *   - parseLibraryRef + LIBRARY_REF_PATTERN: "u", "g<id>", and rejects.
 *   - resolveLibraryRef: ref-wins-over-library_id precedence, legacy fallback
 *     when the ref is absent/unparseable, and unknown-group -> null.
 *   - resolveItemReference tri-state: found / library_unavailable / not_found,
 *     including a simulated cross-device reference (correct library_ref, wrong
 *     library_id) that must resolve via the ref.
 *
 * Prerequisites: dev build running + authenticated. Group-library cases skip
 * automatically when no group library is present.
 * Run: npm run test:live -- libraryIdentity
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    libraryRefForId,
    parseLibraryRefViaHttp,
    resolveLibraryRefViaHttp,
    resolveItemReferenceViaHttp,
} from '../helpers/cacheInspector';
import {
    getLibraryTopology,
    firstItemKey,
    groupIdFromRef,
    type LibraryTopology,
} from '../helpers/libraryTopology';

// A library id that does not exist on any normal install (libraries are small
// contiguous rowids). Used to prove that a valid library_ref beats a wrong id.
const WRONG_LIBRARY_ID = 987654;
// A group id no local install has joined — resolves to "unavailable", not "not_found".
const UNKNOWN_GROUP_REF = 'g99999999';

let available: boolean;
let topo: LibraryTopology;
let personalKey: string | null = null;
let groupKey: string | null = null;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) {
        console.warn('\n⚠  Zotero not available — libraryIdentity live tests will be skipped.\n');
        return;
    }
    topo = await getLibraryTopology();
    personalKey = await firstItemKey(topo.personal.library_id);
    if (topo.group) groupKey = await firstItemKey(topo.group.library_id);
});

describe('libraryRefForLibraryID (op ref_for_id)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns "u" for the personal library', async () => {
        const res = await libraryRefForId(topo.personal.library_id);
        expect(res.library_ref).toBe('u');
    });

    it('returns "g<groupID>" for a group library, matching the library summary', async (ctx) => {
        if (!topo.group) return ctx.skip();
        const res = await libraryRefForId(topo.group.library_id);
        expect(res.library_ref).toMatch(/^g[1-9][0-9]*$/);
        // Must agree with the ref the libraries handler already reports.
        expect(res.library_ref).toBe(topo.group.library_ref);
    });

    it('returns null for the external-file sentinel (-1)', async () => {
        const res = await libraryRefForId(-1);
        expect(res.library_ref).toBeNull();
    });

    it('returns null for a non-existent library id', async () => {
        const res = await libraryRefForId(WRONG_LIBRARY_ID);
        expect(res.library_ref).toBeNull();
    });
});

describe('parseLibraryRef + LIBRARY_REF_PATTERN (op parse)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('parses "u" as the user library', async () => {
        const res = await parseLibraryRefViaHttp('u');
        expect(res.matches_pattern).toBe(true);
        expect(res.parsed).toEqual({ type: 'user' });
    });

    it('parses a group ref into its numeric groupID', async (ctx) => {
        if (!topo.group?.library_ref) return ctx.skip();
        const groupID = groupIdFromRef(topo.group.library_ref)!;
        const res = await parseLibraryRefViaHttp(topo.group.library_ref);
        expect(res.matches_pattern).toBe(true);
        expect(res.parsed).toEqual({ type: 'group', groupID });
    });

    it('rejects "g0" (group id must be >= 1)', async () => {
        const res = await parseLibraryRefViaHttp('g0');
        expect(res.matches_pattern).toBe(false);
        expect(res.parsed).toBeNull();
    });

    it('rejects a non-conforming string', async () => {
        const res = await parseLibraryRefViaHttp('group:2');
        expect(res.matches_pattern).toBe(false);
        expect(res.parsed).toBeNull();
    });

    it('rejects an empty string', async () => {
        const res = await parseLibraryRefViaHttp('');
        expect(res.matches_pattern).toBe(false);
        expect(res.parsed).toBeNull();
    });
});

describe('resolveLibraryRef (op resolve_ref)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('resolves "u" to the personal library even when library_id disagrees', async () => {
        const res = await resolveLibraryRefViaHttp({ library_ref: 'u', library_id: WRONG_LIBRARY_ID });
        expect(res.resolved_library_id).toBe(topo.personal.library_id);
    });

    it('resolves a group ref to its local id, ref winning over a wrong library_id', async (ctx) => {
        if (!topo.group?.library_ref) return ctx.skip();
        const res = await resolveLibraryRefViaHttp({
            library_ref: topo.group.library_ref,
            library_id: WRONG_LIBRARY_ID,
        });
        expect(res.resolved_library_id).toBe(topo.group.library_id);
    });

    it('returns null for an unknown group ref even when library_id is valid', async () => {
        const res = await resolveLibraryRefViaHttp({
            library_ref: UNKNOWN_GROUP_REF,
            library_id: topo.personal.library_id,
        });
        expect(res.resolved_library_id).toBeNull();
    });

    it('falls back to library_id when library_ref is absent (legacy)', async () => {
        const res = await resolveLibraryRefViaHttp({ library_id: topo.personal.library_id });
        expect(res.resolved_library_id).toBe(topo.personal.library_id);
    });

    it('falls back to library_id when library_ref is unparseable', async () => {
        const res = await resolveLibraryRefViaHttp({
            library_ref: 'not-a-ref',
            library_id: topo.personal.library_id,
        });
        expect(res.resolved_library_id).toBe(topo.personal.library_id);
    });
});

describe('resolveItemReference tri-state (op resolve_item)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns found for a valid personal-library reference', async (ctx) => {
        if (!personalKey) return ctx.skip();
        const res = await resolveItemReferenceViaHttp({
            library_id: topo.personal.library_id,
            zotero_key: personalKey,
        });
        expect(res.status).toBe('found');
        expect(res.resolved_library_id).toBe(topo.personal.library_id);
    });

    it('resolves a cross-device group reference via library_ref despite a wrong library_id', async (ctx) => {
        if (!topo.group?.library_ref || !groupKey) return ctx.skip();
        const res = await resolveItemReferenceViaHttp({
            library_ref: topo.group.library_ref,
            library_id: WRONG_LIBRARY_ID,
            zotero_key: groupKey,
        });
        expect(res.status).toBe('found');
        expect(res.resolved_library_id).toBe(topo.group.library_id);
    });

    it('returns library_unavailable for an unknown group ref, not not_found', async (ctx) => {
        if (!groupKey) return ctx.skip();
        // library_id is valid, but the unknown library_ref wins and this device
        // has no such group -> the item may still exist elsewhere.
        const res = await resolveItemReferenceViaHttp({
            library_ref: UNKNOWN_GROUP_REF,
            library_id: topo.group!.library_id,
            zotero_key: groupKey,
        });
        expect(res.status).toBe('library_unavailable');
    });

    it('returns not_found when the library resolves but the key is missing', async () => {
        const res = await resolveItemReferenceViaHttp({
            library_id: topo.personal.library_id,
            zotero_key: 'ZZZZZZZZ',
        });
        expect(res.status).toBe('not_found');
    });

    it('lets library_ref "u" win over a group library_id', async (ctx) => {
        if (!personalKey || !topo.group) return ctx.skip();
        const res = await resolveItemReferenceViaHttp({
            library_ref: 'u',
            library_id: topo.group.library_id,
            zotero_key: personalKey,
        });
        expect(res.status).toBe('found');
        expect(res.resolved_library_id).toBe(topo.personal.library_id);
    });
});
