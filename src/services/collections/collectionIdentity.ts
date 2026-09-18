import { libraryRefForLibraryID, parseItemReference, resolveLibraryRef } from '../../utils/libraryIdentity';

export type CollectionResolutionCode = 'collection_not_found' | 'ambiguous_collection'
    | 'library_unavailable' | 'library_collection_mismatch' | 'library_not_searchable';

export class CollectionResolutionError extends Error {
    constructor(readonly code: CollectionResolutionCode, message: string) {
        super(message);
        this.name = 'CollectionResolutionError';
    }
}

/** Shared recovery guidance for callers retaining the nullable lookup adapter. */
export function collectionNotFoundError(input: string | number): CollectionResolutionError {
    return new CollectionResolutionError('collection_not_found',
        `Collection not found: "${input}" in the requested scope. Call list_collections in the intended library and retry with an exact returned collection ID.`);
}

/** Only pass collections already resolved inside the caller's permitted scope. */
export function collectionLibrariesMismatchError(collections: ResolvedCollection[], operation: 'search' | 'note'): CollectionResolutionError {
    const targets = collections.map(entry => `${entry.collectionId} (library ${entry.libraryRef})`).join('; ');
    const recovery = operation === 'note'
        ? 'A single note can belong to collections in only one library. Choose the intended library and use only collections from that library.'
        : 'This operation searches one library at a time. Send separate requests for each intended library, keeping each request’s collection conditions in that library.';
    return new CollectionResolutionError('library_collection_mismatch',
        `Collections span multiple libraries: ${targets}. ${recovery}`);
}

export interface CollectionScope {
    /** An explicit scope, including an empty scope, is never widened. */
    libraryIds?: readonly number[];
    /** A fixed library, including an item-derived mutation library. Omit for a default scope. */
    libraryID?: number;
    /** Local history enrichment may read excluded libraries without exporting data. */
    access?: 'agent' | 'local';
    /** Exact recorded targets only, for explicit undo/restore operations. */
    includeTrashed?: boolean;
}

export interface ResolvedCollection {
    collectionId: string;
    libraryRef: string;
    libraryID: number;
    key: string;
    name: string;
    collection: Zotero.Collection;
}

/** Format a scoped native key without guessing an unavailable library mapping. */
export function formatCollectionId(libraryID: number, key: string): string {
    const ref = libraryRefForLibraryID(libraryID);
    if (!ref) throw new CollectionResolutionError('library_unavailable', 'The collection library identity is unavailable. Call list_libraries and retry in the intended library.');
    return `${ref}-${key}`;
}

/** Portable identity never fabricates a personal-library ID for an unmapped group. */
export function serializeCollectionIdentity(collection: Zotero.Collection): {
    collection_id: string; library_ref: string; name: string; parent_collection_id?: string;
} {
    const ref = libraryRefForLibraryID(collection.libraryID);
    if (!ref) throw new CollectionResolutionError('library_unavailable', `Cannot produce a portable ID for collection key "${collection.key}": its library identity is unavailable on this computer. Call list_libraries to check available library references. If the intended library is still unavailable, ask the user to make it available in Zotero, then retry; do not assume the personal library.`);
    return {
        collection_id: formatCollectionId(collection.libraryID, collection.key),
        library_ref: ref,
        name: collection.name,
        ...(collection.parentKey ? { parent_collection_id: formatCollectionId(collection.libraryID, collection.parentKey) } : {}),
    };
}

function allowedLibraries(scope: CollectionScope): number[] {
    const accessible = scope.access === 'local'
        ? Zotero.Libraries.getAll().map(library => library.libraryID)
        : Zotero.Beaver?.libraryScopeInitialized ? [...Zotero.Beaver.searchableLibraryIds ?? []] : [];
    return accessible.filter(id => (scope.libraryIds === undefined || scope.libraryIds.includes(id))
        && (scope.libraryID === undefined || scope.libraryID === id));
}

function found(collection: Zotero.Collection): ResolvedCollection {
    const identity = serializeCollectionIdentity(collection);
    return { collectionId: identity.collection_id, libraryRef: identity.library_ref,
        libraryID: collection.libraryID, key: collection.key, name: collection.name, collection };
}

function ambiguity(input: string | number, collections: Zotero.Collection[]): CollectionResolutionError {
    const candidates = collections.map(collection => {
        const path = [collection.name];
        const seen = new Set([collection.id]);
        let parentID = collection.parentID;
        while (parentID && !seen.has(parentID)) {
            seen.add(parentID);
            const parent = Zotero.Collections.get(parentID);
            if (!parent || parent.libraryID !== collection.libraryID || parent.deleted) break;
            path.unshift(parent.name);
            parentID = parent.parentID;
        }
        return `${serializeCollectionIdentity(collection).collection_id} (${path.join(' / ')})`;
    });
    return new CollectionResolutionError('ambiguous_collection', `Ambiguous collection "${input}". Use a collection ID: ${candidates.join('; ')}.`);
}

/** Resolve exactly one collection within the permitted scope, excluding trash. */
export function resolveCollection(input: string | number, scope: CollectionScope = {}): ResolvedCollection {
    const allowed = allowedLibraries(scope);
    if (!allowed.length) {
        const recovery = scope.access !== 'local' && !Zotero.Beaver?.libraryScopeInitialized
            ? 'Library access is still loading. Retry after Zotero finishes initializing; keep the same collection reference and scope.'
            : 'The requested scope contains no accessible libraries. Call list_libraries and select the intended available library. If it is absent, ask the user to check Beaver Library Access and Zotero library availability.';
        throw new CollectionResolutionError('library_not_searchable', `Cannot resolve collection "${input}". ${recovery}`);
    }
    const missing = () => collectionNotFoundError(input);
    const checkLibrary = (id: number) => {
        if (scope.libraryID !== undefined && id !== scope.libraryID) {
            // Only identify the source library when it is accessible independently
            // of the request's narrower scope; never reveal an excluded mapping.
            const sourceRef = allowedLibraries({ access: scope.access }).includes(id)
                ? libraryRefForLibraryID(id) : null;
            const source = sourceRef ? ` from library "${sourceRef}"` : '';
            throw new CollectionResolutionError('library_collection_mismatch', `Collection reference "${input}"${source} belongs to a different library than the requested library "${libraryRefForLibraryID(scope.libraryID) ?? scope.libraryID}". Call list_collections in the requested library and use a returned ID. If the reference's library is the intended target, explicitly select that library instead; do not strip the reference's library prefix.`);
        }
        if (!allowed.includes(id)) throw new CollectionResolutionError('library_not_searchable', `Collection reference "${input}" is not available within the requested search scope. Call list_libraries, then list_collections in the intended available library and retry with a returned ID. If the intended library is absent, ask the user to check Beaver Library Access and Zotero library availability; do not substitute another library.`);
    };
    const exact = (id: number, key: string) => {
        checkLibrary(id);
        const collection = Zotero.Collections.getByLibraryAndKey(id, key);
        if (!collection || (collection.deleted && !scope.includeTrashed)) throw missing();
        return found(collection);
    };
    const value = String(input).trim();
    const parsed = parseItemReference(value);
    if (parsed) {
        const id = parsed.library_ref ? resolveLibraryRef(parsed) : parsed.library_id;
        if (id == null) throw new CollectionResolutionError('library_unavailable', `Cannot resolve collection "${input}": library reference "${parsed.library_ref}" is unavailable on this computer. Call list_libraries to check available library references. Ask the user to make the intended library available in Zotero if it is absent, then retry with the same qualified ID; do not fall back to the personal library.`);
        return exact(id, parsed.zotero_key);
    }
    // Native search conditions also accept the legacy libraryID_key spelling.
    const native = /^(\d+)_([A-Z0-9]{8})$/.exec(value);
    if (native) return exact(Number(native[1]), native[2]);
    if (typeof input === 'number') {
        const collection = Zotero.Collections.get(Number(input));
        if (!collection || collection.deleted) throw missing();
        checkLibrary(collection.libraryID);
        return found(collection);
    }
    let matches: Zotero.Collection[] = [];
    if (/^[A-Z0-9]{8}$/.test(value)) {
        matches = allowed.map(id => Zotero.Collections.getByLibraryAndKey(id, value))
            .filter((collection): collection is Zotero.Collection => !!collection && !collection.deleted);
    }
    if (!matches.length && /^\d+$/.test(value)) {
        const collection = Zotero.Collections.get(Number(value));
        if (collection && !collection.deleted) {
            checkLibrary(collection.libraryID);
            return found(collection);
        }
    }
    if (!matches.length) {
        matches = allowed.flatMap(id => Zotero.Collections.getByLibrary(id, true))
            .filter(collection => !collection.deleted && collection.name.toLowerCase() === value.toLowerCase());
    }
    if (matches.length > 1) throw ambiguity(input, matches);
    if (!matches.length) throw missing();
    return found(matches[0]);
}

export interface CollectionListResolution {
    collections: ResolvedCollection[];
    /** Successful references in input order, including aliases of the same identity. */
    resolvedInputs: { input: string | number; resolved: ResolvedCollection }[];
    failures: { input: string | number; error: CollectionResolutionError }[];
}

/** Resolve a list with the same rules and deduplicate by portable identity. */
export function resolveCollectionList(inputs: readonly (string | number)[], scope: CollectionScope = {}): CollectionListResolution {
    const collections = new Map<string, ResolvedCollection>();
    const failures: CollectionListResolution['failures'] = [];
    const resolvedInputs: CollectionListResolution['resolvedInputs'] = [];
    for (const input of inputs) {
        try {
            const resolved = resolveCollection(input, scope);
            collections.set(resolved.collectionId, resolved);
            resolvedInputs.push({ input, resolved });
        } catch (error) {
            if (!(error instanceof CollectionResolutionError)) throw error;
            failures.push({ input, error });
        }
    }
    return { collections: [...collections.values()], resolvedInputs, failures };
}
