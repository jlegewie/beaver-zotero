/**
 * Library-exclusion live suite.
 *
 * Covers the `feat-library-exclusion` change (current branch vs v0.22): users
 * can exclude a Zotero library from Beaver, and Beaver must not read, search,
 * confirm the existence of, or modify anything in an excluded library. The
 * boundary is enforced in every read/data handler, in the search/reference
 * scoping, and in both the validate- and execute-time paths of the agent
 * actions.
 *
 * The suite drives the in-memory excluded set through the dev-only
 * `/beaver/test/excluded-libraries` endpoint (which mutates the profile atom
 * only — nothing is persisted to the backend) and restores the original set
 * after every test. It asserts:
 *   - read/data handlers reject an excluded library with `library_excluded`
 *     (document, page-images, search, view-images, attachment-image,
 *     get-annotations, zotero-data per-reference) or hide the item entirely
 *     (metadata `not_found`, read-note error)
 *   - the rejection is identical for a real and a nonexistent key (no
 *     existence leak) and differs from a searchable library's `not_found`
 *   - group-library exclusion works (keyed `group:<id>`)
 *   - topic search and external-reference-check are scoped to the searchable
 *     set (excluded libraries are never matched)
 *   - agent actions reject an excluded target library at validate time and via
 *     the execute-time TOCTOU guard, with `library_not_searchable`
 *   - access is fully restored once a library is un-excluded
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated with a loaded profile (the driver needs a profile).
 *   - Fixture items seeded: SMALL_PDF, IMAGE, PARENT_ITEM (a library-1
 *     journalArticle with a DOI) in the user library; GROUP_LIB2_PDF in a
 *     group library.
 *
 * Run with: `npm run test:live -- libraryExclusion`
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { fetchDocument, fetchPageImages, searchAttachment } from '../helpers/zoteroHttpClient';
import {
    getExcludedLibraries,
    setExcludedLibraries,
    restoreExcludedLibraries,
    getAnnotations,
    viewAttachmentImages,
    fetchAttachmentImage,
    type ExcludedLibraryEntry,
} from '../helpers/cacheInspector';
import {
    SMALL_PDF,
    IMAGE,
    PARENT_ITEM,
    GROUP_LIB2_PDF,
} from '../helpers/fixtures';

// Stable fragments of `excludedLibraryMessage` — asserted instead of the exact
// text so a library rename doesn't break the suite.
const EXCLUDED_FRAGMENT = 'excluded from Beaver';
const PREFERENCES_FRAGMENT = 'Beaver Preferences';

const USER_LIBRARY_ID = SMALL_PDF.library_id; // 1
const GROUP_LIBRARY_ID = GROUP_LIB2_PDF.library_id; // a group library

let available = false;
/** The excluded set present before the suite ran — restored after each test. */
let originalExcluded: ExcludedLibraryEntry[] = [];
/** Whether a profile is loaded (the driver cannot set exclusions without one). */
let hasProfile = false;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    const state = await getExcludedLibraries();
    hasProfile = state.has_profile;
    originalExcluded = state.excluded_libraries ?? [];
});

/** Overwrite the excluded set so exactly `libraryIds` are excluded. */
async function exclude(libraryIds: number[]): Promise<void> {
    const res = await setExcludedLibraries(libraryIds);
    expect(res.ok).toBe(true);
    expect(res.has_profile).toBe(true);
    for (const id of libraryIds) {
        expect(res.searchable_library_ids).not.toContain(id);
    }
}

beforeEach((ctx) => {
    skipIfNoZotero(ctx, available);
    // The whole suite depends on the driver, which needs a loaded profile.
    if (!hasProfile) ctx.skip();
});

afterEach(async () => {
    if (!available || !hasProfile) return;
    await restoreExcludedLibraries(originalExcluded);
});

afterAll(async () => {
    if (!available || !hasProfile) return;
    await restoreExcludedLibraries(originalExcluded);
});

// -------------------------------------------------------------------------
// Driver sanity
// -------------------------------------------------------------------------

describe('/beaver/test/excluded-libraries driver', () => {
    it('reports a loaded profile and the current searchable set', async () => {
        const state = await getExcludedLibraries();
        expect(state.ok).toBe(true);
        expect(state.has_profile).toBe(true);
        expect(Array.isArray(state.searchable_library_ids)).toBe(true);
        expect(state.local_library_ids).toContain(USER_LIBRARY_ID);
    });

    it('removes a library from the searchable set when excluded', async () => {
        await exclude([USER_LIBRARY_ID]);
        const state = await getExcludedLibraries();
        expect(state.searchable_library_ids).not.toContain(USER_LIBRARY_ID);
    });
});

// -------------------------------------------------------------------------
// Read & data handlers reject an excluded library
// -------------------------------------------------------------------------

interface MetadataResponse {
    items: Array<{ key: string }>;
    not_found?: string[];
    error?: string | null;
    error_code?: string | null;
}

interface ReadNoteResponse {
    success: boolean;
    error?: string | null;
}

interface ZoteroDataResponse {
    items?: unknown[];
    errors?: Array<{
        reference: { library_id: number; zotero_key: string };
        error: string;
        error_code?: string;
    }>;
}

describe('read & data handlers reject excluded libraries', () => {
    beforeEach(async () => {
        await exclude([USER_LIBRARY_ID]);
    });

    it('whole-document extraction returns library_excluded', async () => {
        const res = await fetchDocument(SMALL_PDF, { mode: 'markdown', max_pages: 1 });
        expect(res.error_code).toBe('library_excluded');
        expect(res.error).toContain(EXCLUDED_FRAGMENT);
        expect(res.error).toContain(PREFERENCES_FRAGMENT);
        expect(res.result).toBeFalsy();
    });

    it('page-images returns library_excluded', async () => {
        const res = await fetchPageImages(SMALL_PDF, { pages: [1] });
        expect(res.error_code).toBe('library_excluded');
        expect(res.pages ?? []).toHaveLength(0);
    });

    it('attachment search returns library_excluded', async () => {
        const res = await searchAttachment(SMALL_PDF, 'the');
        expect(res.error_code).toBe('library_excluded');
    });

    it('view-images returns library_excluded for a Zotero attachment', async () => {
        const res = await viewAttachmentImages(SMALL_PDF, { start_page: 1, end_page: 1 });
        expect(res.error_code).toBe('library_excluded');
        expect(res.images ?? []).toHaveLength(0);
    });

    it('attachment-image returns library_excluded', async () => {
        const res = await fetchAttachmentImage(IMAGE);
        expect(res.error_code).toBe('library_excluded');
    });

    it('get-annotations returns library_excluded', async () => {
        const res = await getAnnotations(SMALL_PDF);
        expect(res.error_code).toBe('library_excluded');
        expect(res.annotations ?? []).toHaveLength(0);
    });

    it('metadata reports excluded items as not_found and serves no data', async () => {
        const itemId = `${PARENT_ITEM.library_id}-${PARENT_ITEM.zotero_key}`;
        const res = await post<MetadataResponse>('/beaver/library/metadata', {
            item_ids: [itemId],
        });
        expect(res.items).toHaveLength(0);
        expect(res.not_found).toContain(itemId);
    });

    it('read-note rejects an excluded note before lookup', async () => {
        const noteId = `${PARENT_ITEM.library_id}-${PARENT_ITEM.zotero_key}`;
        const res = await post<ReadNoteResponse>('/beaver/note/read', { note_id: noteId });
        expect(res.success).toBe(false);
        expect(res.error).toContain(EXCLUDED_FRAGMENT);
    });

    it('zotero-data reports excluded references as library_excluded errors', async () => {
        const res = await post<ZoteroDataResponse>('/beaver/zotero-data', {
            items: [{ library_id: PARENT_ITEM.library_id, zotero_key: PARENT_ITEM.zotero_key }],
        });
        expect(res.items ?? []).toHaveLength(0);
        expect(res.errors).toBeTruthy();
        const err = res.errors!.find((e) => e.reference.zotero_key === PARENT_ITEM.zotero_key);
        expect(err).toBeTruthy();
        expect(err!.error_code).toBe('library_excluded');
        expect(err!.error).toContain(EXCLUDED_FRAGMENT);
    });
});

// -------------------------------------------------------------------------
// No existence leak: excluded == indistinguishable from missing
// -------------------------------------------------------------------------

describe('excluded libraries never leak item existence', () => {
    const FAKE_KEY = 'ZZZZZZZZ';

    it('document rejection is identical for a real and a nonexistent key', async () => {
        await exclude([USER_LIBRARY_ID]);
        const real = await fetchDocument(SMALL_PDF, { mode: 'markdown', max_pages: 1 });
        const fake = await fetchDocument(
            { ...SMALL_PDF, zotero_key: FAKE_KEY },
            { mode: 'markdown', max_pages: 1 },
        );
        expect(real.error_code).toBe('library_excluded');
        expect(fake.error_code).toBe('library_excluded');
        expect(fake.error).toBe(real.error);
    });

    it('read-note returns the exclusion message (not "not found") for a missing key in an excluded library', async () => {
        await exclude([USER_LIBRARY_ID]);
        const res = await post<ReadNoteResponse>('/beaver/note/read', {
            note_id: `${USER_LIBRARY_ID}-${FAKE_KEY}`,
        });
        expect(res.success).toBe(false);
        expect(res.error).toContain(EXCLUDED_FRAGMENT);
        expect(res.error?.toLowerCase()).not.toContain('not found');
    });

    it('read-note returns "not found" for a missing key in a searchable library', async () => {
        // Original state keeps the user library searchable.
        const res = await post<ReadNoteResponse>('/beaver/note/read', {
            note_id: `${USER_LIBRARY_ID}-${FAKE_KEY}`,
        });
        expect(res.success).toBe(false);
        expect(res.error).toContain('not found');
        expect(res.error).not.toContain(EXCLUDED_FRAGMENT);
    });
});

// -------------------------------------------------------------------------
// Group-library exclusion (keyed group:<id>)
// -------------------------------------------------------------------------

describe('group-library exclusion', () => {
    it('excludes a group library and rejects its attachments', async () => {
        // Baseline: the group library is searchable in the original set.
        const before = await getExcludedLibraries();
        expect(before.searchable_library_ids).toContain(GROUP_LIBRARY_ID);

        await exclude([GROUP_LIBRARY_ID]);
        const res = await fetchDocument(GROUP_LIB2_PDF, { mode: 'markdown', max_pages: 1 });
        expect(res.error_code).toBe('library_excluded');
        expect(res.error).toContain(EXCLUDED_FRAGMENT);
    });
});

// -------------------------------------------------------------------------
// Search & reference-check are scoped to searchable libraries
// -------------------------------------------------------------------------

interface TopicSearchResponse {
    items: unknown[];
}

interface ReferenceCheckResponse {
    results: Array<{ id: string; exists: boolean; item?: { library_id: number; zotero_key: string } }>;
}

describe('search and reference-check honor the searchable set', () => {
    it('topic search returns no items when every library is excluded', async () => {
        const state = await getExcludedLibraries();
        await exclude(state.local_library_ids);
        const res = await post<TopicSearchResponse>('/beaver/search/topic', {
            topic_query: 'police stops race gender',
            limit: 5,
        });
        expect(res.items).toHaveLength(0);
    });

    describe('external-reference-check DOI matching', () => {
        // Resolve a real, matchable reference (DOI) from the fixture so the test
        // is fixture-based rather than hard-coding a DOI string.
        let doiRef: { id: string; doi: string } | null = null;

        beforeEach(async () => {
            if (doiRef) return;
            const meta = await post<{ items: Array<{ DOI?: string }> }>('/beaver/library/metadata', {
                item_ids: [`${PARENT_ITEM.library_id}-${PARENT_ITEM.zotero_key}`],
            });
            const doi = meta.items[0]?.DOI;
            if (doi) doiRef = { id: 'ref-1', doi };
        });

        it('matches the item in a searchable library (baseline)', async () => {
            expect(doiRef).toBeTruthy();
            const res = await post<ReferenceCheckResponse>('/beaver/external-reference-check', {
                library_ids: [USER_LIBRARY_ID],
                items: [doiRef],
            });
            expect(res.results[0].exists).toBe(true);
            expect(res.results[0].item?.library_id).toBe(USER_LIBRARY_ID);
        });

        it('does not match when the requested library is excluded', async () => {
            expect(doiRef).toBeTruthy();
            await exclude([USER_LIBRARY_ID]);
            const res = await post<ReferenceCheckResponse>('/beaver/external-reference-check', {
                library_ids: [USER_LIBRARY_ID],
                items: [doiRef],
            });
            expect(res.results[0].exists).toBe(false);
        });

        it('never returns a match from the excluded library via the default set', async () => {
            // The default (unspecified) library set now resolves to the searchable
            // set, so a match must never come from the excluded library — even if
            // the same reference is duplicated in another, searchable library.
            expect(doiRef).toBeTruthy();
            await exclude([USER_LIBRARY_ID]);
            const res = await post<ReferenceCheckResponse>('/beaver/external-reference-check', {
                items: [doiRef],
            });
            expect(res.results[0].item?.library_id).not.toBe(USER_LIBRARY_ID);
        });
    });
});

// -------------------------------------------------------------------------
// Agent actions reject an excluded target library
// -------------------------------------------------------------------------

interface ValidateResponse {
    valid: boolean;
    error?: string | null;
    error_code?: string | null;
}

interface ExecuteResponse {
    success: boolean;
    error?: string | null;
    error_code?: string | null;
}

function validate(actionType: string, actionData: Record<string, unknown>): Promise<ValidateResponse> {
    return post<ValidateResponse>('/beaver/agent-action/validate', {
        action_type: actionType,
        action_data: actionData,
    });
}

function execute(actionType: string, actionData: Record<string, unknown>): Promise<ExecuteResponse> {
    return post<ExecuteResponse>('/beaver/agent-action/execute', {
        action_type: actionType,
        action_data: actionData,
    });
}

describe('agent actions reject excluded target libraries', () => {
    it('create_collection validation passes for a searchable library (baseline)', async () => {
        // Original state keeps the user library searchable; validate never mutates.
        const res = await validate('create_collection', {
            name: 'Exclusion Suite Baseline',
            library_id: USER_LIBRARY_ID,
        });
        expect(res.valid).toBe(true);
    });

    describe('with the user library excluded', () => {
        beforeEach(async () => {
            await exclude([USER_LIBRARY_ID]);
        });

        it('create_collection validation is rejected as library_not_searchable', async () => {
            const res = await validate('create_collection', {
                name: 'Should Not Validate',
                library_id: USER_LIBRARY_ID,
            });
            expect(res.valid).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
            expect(res.error).toContain(EXCLUDED_FRAGMENT);
        });

        it('create_note validation is rejected as library_not_searchable', async () => {
            const res = await validate('create_note', {
                title: 'Should Not Validate',
                content: 'body',
                library_id: USER_LIBRARY_ID,
            });
            expect(res.valid).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
        });

        it('create_collection execute is blocked by the TOCTOU guard', async () => {
            const res = await execute('create_collection', {
                name: 'Should Not Execute',
                library_id: USER_LIBRARY_ID,
            });
            expect(res.success).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
        });

        it('create_note execute is blocked by the TOCTOU guard', async () => {
            const res = await execute('create_note', {
                title: 'Should Not Execute',
                content: 'body',
                library_id: USER_LIBRARY_ID,
            });
            expect(res.success).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
        });

        it('create_item execute is blocked by the TOCTOU guard', async () => {
            const res = await execute('create_item', {
                library_id: USER_LIBRARY_ID,
                item: { itemType: 'journalArticle', title: 'Should Not Execute' },
            });
            expect(res.success).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
        });

        it('manage_tags execute is blocked by the TOCTOU guard', async () => {
            const res = await execute('manage_tags', {
                action: 'delete',
                name: '__exclusion_suite_missing_tag__',
                library_id: USER_LIBRARY_ID,
            });
            expect(res.success).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
        });

        it('edit_note execute is blocked by the TOCTOU guard', async () => {
            const res = await execute('edit_note', {
                library_id: USER_LIBRARY_ID,
                zotero_key: 'ZZZZZZZZ',
                old_string: 'a',
                new_string: 'b',
            });
            expect(res.success).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
        });

        it('edit_metadata execute is blocked by the TOCTOU guard', async () => {
            const res = await execute('edit_metadata', {
                library_id: USER_LIBRARY_ID,
                zotero_key: 'ZZZZZZZZ',
                fields: { title: 'Should Not Execute' },
            });
            expect(res.success).toBe(false);
            expect(res.error_code).toBe('library_not_searchable');
        });
    });
});

// -------------------------------------------------------------------------
// Access is restored when a library is un-excluded
// -------------------------------------------------------------------------

describe('un-excluding a library restores access', () => {
    it('document extraction no longer reports library_excluded after restore', async () => {
        await exclude([USER_LIBRARY_ID]);
        const excluded = await fetchDocument(SMALL_PDF, { mode: 'markdown', max_pages: 1 });
        expect(excluded.error_code).toBe('library_excluded');

        // Restore to the original set (user library searchable again).
        await restoreExcludedLibraries(originalExcluded);
        const restored = await fetchDocument(SMALL_PDF, { mode: 'markdown', max_pages: 1 });
        expect(restored.error_code).not.toBe('library_excluded');
    });
});
