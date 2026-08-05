/**
 * In-test stand-in for the shared collection resolver in
 * `src/services/agentDataProvider/utils.ts`.
 *
 * That module pulls in document extraction, sync and supabase, so action suites
 * mock it wholesale — but the actions under test only behave correctly if
 * resolution behaves like the real thing. This mirrors the documented rules over
 * a small fixture set: a scoped identifier is authoritative and never falls
 * through to a name, a bare key is unique only within a library, names match
 * case-insensitively, and write resolution rejects a name outright.
 */

export interface FakeCollection {
    id: number;
    key: string;
    libraryID: number;
    name: string;
    [extra: string]: unknown;
}

export interface CollectionResolverFakeState {
    collections: FakeCollection[];
    /** libraryID -> portable library_ref ("u" | "g<groupID>"). Also the set of local libraries. */
    libraryRefs: Record<number, string>;
    /** Libraries the user has NOT excluded from Beaver. */
    searchableLibraryIds: number[];
    /** libraryID -> display name, for the messages the model reads. */
    libraryNames?: Record<number, string>;
}

/** Mirrors Zotero's key alphabet (no 0, 1 or O). */
const KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const LIBRARY_REF_PATTERN = /^(u|g[1-9][0-9]*)$/;

type Failure = { ok: false; code: string; message: string };
type Match = { collection: FakeCollection; libraryID: number };

function notFound(input: unknown): Failure {
    return { ok: false, code: 'collection_not_found', message: `Collection not found: ${input}` };
}

export function createCollectionResolverFake(state: CollectionResolverFakeState) {
    const libraryName = (libraryID: number) => state.libraryNames?.[libraryID] ?? `library ${libraryID}`;
    const modelObjectId = (libraryID: number, key: string) => `${state.libraryRefs[libraryID] ?? libraryID}-${key}`;

    /** Scoped identifier ("u-KEY" / "g123-KEY" / "1-KEY"); libraryID 0 = unavailable here. */
    function parseScoped(input: string): { libraryID: number; key: string } | null {
        const idx = input.indexOf('-');
        if (idx <= 0 || idx === input.length - 1) return null;
        const prefix = input.slice(0, idx);
        const key = input.slice(idx + 1);
        if (!KEY_PATTERN.test(key)) return null;
        if (/^[1-9][0-9]*$/.test(prefix)) return { libraryID: Number(prefix), key };
        if (!LIBRARY_REF_PATTERN.test(prefix)) return null;
        const entry = Object.entries(state.libraryRefs).find(([, ref]) => ref === prefix);
        return { libraryID: entry ? Number(entry[0]) : 0, key };
    }

    /** Mirrors `Zotero.Libraries.get()` returning false for an id this device doesn't have. */
    function hasLocalLibrary(libraryID: number): boolean {
        return Object.prototype.hasOwnProperty.call(state.libraryRefs, libraryID);
    }

    function resolveRowId(rowId: number, eligible: number[], input: unknown) {
        const collection = state.collections.find((c) => c.id === rowId);
        if (!collection || !eligible.includes(collection.libraryID)) return notFound(input);
        return { ok: true as const, matchKind: 'row_id' as const, match: { collection, libraryID: collection.libraryID } };
    }

    function ambiguous(input: unknown, matches: Match[]): Failure {
        const candidates = matches.map((m) => modelObjectId(m.libraryID, m.collection.key)).join('; ');
        return {
            ok: false,
            code: 'ambiguous_collection',
            message: `"${input}" matches ${matches.length} collections: ${candidates}. Retry with the scoped collection identifier of the one you want.`,
        };
    }

    function resolveSingleCollection(input: unknown, options: any) {
        if (input == null) return notFound('');
        const eligible = [...new Set<number>(options?.eligibleLibraryIds ?? [])];
        const nameLibraryIds = [...new Set<number>(options?.nameLibraryIds ?? eligible)];

        if (typeof input === 'number') return resolveRowId(input, eligible, input);
        if (typeof input !== 'string' || !input.trim()) return notFound(input);

        const scoped = parseScoped(input);
        if (scoped) {
            if (scoped.libraryID === 0 || !hasLocalLibrary(scoped.libraryID)) {
                return {
                    ok: false as const,
                    code: 'library_unavailable',
                    message: `The collection "${input}" is in a library that is not available on this computer.`,
                };
            }
            // `eligibleLibraryIds` is the authority for every grammar; outside it
            // an explicit library scope conflicts and an excluded library stops
            // the lookup before it can disclose whether the collection exists.
            if (!eligible.includes(scoped.libraryID)) {
                if (options?.explicitLibrary) {
                    return {
                        ok: false as const,
                        code: 'invalid_request',
                        message:
                            `The collection "${input}" is not in library "${eligible.map(libraryName).join('", "')}", ` +
                            `which the request asked for.`,
                    };
                }
                if (!state.searchableLibraryIds.includes(scoped.libraryID)) {
                    return {
                        ok: false as const,
                        code: 'library_not_searchable',
                        message: `The library "${libraryName(scoped.libraryID)}" is excluded from Beaver.`,
                    };
                }
            }
            const collection = state.collections.find((c) => c.libraryID === scoped.libraryID && c.key === scoped.key);
            if (!collection) return notFound(input);
            return { ok: true as const, matchKind: 'identifier' as const, match: { collection, libraryID: collection.libraryID } };
        }

        if (KEY_PATTERN.test(input)) {
            const keyMatches = state.collections
                .filter((c) => eligible.includes(c.libraryID) && c.key === input)
                .map((collection) => ({ collection, libraryID: collection.libraryID }));
            if (keyMatches.length > 1) return ambiguous(input, keyMatches);
            if (keyMatches.length === 1) return { ok: true as const, matchKind: 'key' as const, match: keyMatches[0] };
        }

        const inputLower = input.toLowerCase();
        const nameMatches = state.collections
            .filter((c) => nameLibraryIds.includes(c.libraryID) && c.name.toLowerCase() === inputLower)
            .map((collection) => ({ collection, libraryID: collection.libraryID }));
        if (nameMatches.length > 1) return ambiguous(input, nameMatches);
        if (nameMatches.length === 1) return { ok: true as const, matchKind: 'name' as const, match: nameMatches[0] };

        if (/^\d+$/.test(input)) return resolveRowId(parseInt(input, 10), eligible, input);

        return notFound(input);
    }

    function resolveCollectionForWrite(input: unknown, options: any) {
        const resolution: any = resolveSingleCollection(input, options);
        if (!resolution.ok) return resolution;
        if (resolution.matchKind === 'name') {
            const { collection, libraryID } = resolution.match;
            return {
                ok: false as const,
                code: 'invalid_request',
                message:
                    `"${input}" is a collection name, and this operation needs a collection identifier. ` +
                    `Pass ${modelObjectId(libraryID, collection.key)}, the identifier list_collections returns ` +
                    `for "${collection.name}".`,
            };
        }
        return { ok: true as const, match: resolution.match };
    }

    /** Mirrors the exported parser: an `ObjectIdReference`, or null for a bare key / name. */
    function parseScopedCollectionId(input: string) {
        const scoped = parseScoped(input);
        if (!scoped) return null;
        return {
            library_id: scoped.libraryID,
            library_ref: state.libraryRefs[scoped.libraryID],
            zotero_key: scoped.key,
        };
    }

    return {
        parseScopedCollectionId,
        resolveSingleCollection,
        resolveCollectionForWrite,
        getSearchableLibraryIds: () => state.searchableLibraryIds,
        isLibrarySearchable: (libraryID: number) => state.searchableLibraryIds.includes(libraryID),
    };
}
