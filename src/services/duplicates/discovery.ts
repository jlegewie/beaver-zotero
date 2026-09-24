import type {
    DuplicateGroup,
    DuplicateMember,
    DuplicatesRequest,
    DuplicatesResponse,
} from "@beaver/agent-core/protocol/duplicates";
import {
    checkLibraryExcluded,
    getCollectionByIdOrName,
    validateLibraryAccess,
} from "../agentDataProvider/utils";
import {
    libraryRefForLibraryID,
    modelObjectId,
    parseItemReference,
    resolveLibraryRef,
} from "../../utils/libraryIdentity";

export class DuplicateError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = "DuplicateError";
    }
}
export function duplicateError(message: string, code = "invalid_merge"): DuplicateError {
    return new DuplicateError(message, code);
}
export function stableJSON(value: unknown): string {
    if (Array.isArray(value))
        return "[" + value.map(stableJSON).join(",") + "]";
    if (value && typeof value === "object")
        return (
            "{" +
            Object.keys(value)
                .sort()
                .map(
                    (k) =>
                        JSON.stringify(k) +
                        ":" +
                        stableJSON((value as Record<string, unknown>)[k]),
                )
                .join(",") +
            "}"
        );
    return JSON.stringify(value) ?? "null";
}
export async function loadDuplicateItems(
    ids: string[],
    allowDeleted = false,
): Promise<Zotero.Item[]> {
    if (
        !Array.isArray(ids) ||
        ids.length < 2 ||
        ids.length > 25 ||
        new Set(ids).size !== ids.length
    ) {
        throw duplicateError("Provide 2–25 distinct item IDs.");
    }
    const items: Zotero.Item[] = [];
    for (const id of ids) {
        const ref = parseItemReference(id);
        const libraryID = ref && resolveLibraryRef(ref);
        if (!ref || !libraryID)
            throw duplicateError(
                "Item library is unavailable.",
                "library_unavailable",
            );
        const excluded = checkLibraryExcluded(libraryID);
        if (excluded)
            throw duplicateError(excluded.message, "library_excluded");
        if (items.length && items[0].libraryID !== libraryID)
            throw duplicateError("Items must belong to the same library.");
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            ref.zotero_key,
        );
        if (!item || (!allowDeleted && item.deleted))
            throw duplicateError(
                `Item ${id} is unavailable or trashed.`,
                "item_unavailable",
            );
        if (
            !item.isRegularItem() ||
            item.isNote() ||
            item.isAttachment() ||
            (item as any).isAnnotation()
        )
            throw duplicateError(
                "Only regular bibliographic items can be merged.",
            );
        items.push(item);
    }
    if (new Set(items.map((i) => i.id)).size !== items.length)
        throw duplicateError("Item IDs resolve to the same item.");
    await Zotero.Items.loadDataTypes(items, [
        "itemData",
        "creators",
        "tags",
        "collections",
        "childItems",
        "relations",
    ]);
    return items;
}
const SYSTEM_FIELDS = new Set([
    "key",
    "version",
    "itemType",
    "dateAdded",
    "dateModified",
    "collections",
    "tags",
    "relations",
    "deleted",
    "parentItem",
    "inPublications",
    "citationKey",
]);
export async function describeGroup(
    items: Zotero.Item[],
): Promise<DuplicateGroup> {
    await Zotero.Items.loadDataTypes(items, [
        "itemData",
        "creators",
        "tags",
        "collections",
        "childItems",
        "relations",
    ]);
    const members: DuplicateMember[] = [];
    for (const item of items) {
        const json = item.toJSON() as Record<string, unknown>;
        const fields = Object.fromEntries(
            Object.entries(json).filter(([key]) => !SYSTEM_FIELDS.has(key)),
        );
        // Every field below is required on the wire. A missing library ref (a
        // feed, or a group cache that is not ready) must fail this request
        // with a readable code rather than emit null and fail validation on
        // the far side, which would kill the whole call.
        const library_ref = libraryRefForLibraryID(item.libraryID);
        if (!library_ref)
            throw duplicateError(
                "Item library is unavailable.",
                "library_unavailable",
            );
        const member: DuplicateMember = {
            item_id: modelObjectId(item.libraryID, item.key),
            library_ref,
            zotero_key: item.key,
            title: String(item.getField("title") || "Untitled"),
            item_type: item.itemType,
            creators: String(item.getField("firstCreator") || ""),
            date: String(item.getField("date") || ""),
            doi: String(item.getField("DOI") || ""),
            isbn: String(item.getField("ISBN") || ""),
            date_added: item.dateAdded,
            attachment_count: item.getAttachments().length,
            note_count: item.getNotes().length,
            fields,
        };
        const children = await Zotero.Items.getAsync([
            ...item.getAttachments(),
            ...item.getNotes(),
        ]);
        await Zotero.Items.loadDataTypes(children, [
            "itemData",
            "childItems",
            "note",
        ]);
        member.children = children.map((child) => ({
            item_id: modelObjectId(child.libraryID, child.key),
            title: String(child.getField("title") || ""),
            item_type: child.itemType,
            annotation_count: child.isFileAttachment()
                ? (child as any).getAnnotations(false, true).length
                : 0,
        }));
        members.push(member);
    }
    const fieldNames = new Set(members.flatMap((m) => Object.keys(m.fields)));
    const differing_fields = [...fieldNames]
        .filter(
            (f) =>
                new Set(members.map((m) => stableJSON(m.fields[f] ?? "")))
                    .size > 1,
        )
        .sort();
    const warnings: string[] = [];
    const editable = !!(Zotero.Libraries.get(items[0].libraryID) as any)
        ?.editable;
    const oneItemType = new Set(members.map((m) => m.item_type)).size === 1;
    const mergeable = oneItemType && editable;
    if (!oneItemType)
        warnings.push("Different item types: these items cannot be merged.");
    if (!editable) warnings.push("This library is read-only.");
    if (
        new Set(members.map((m) => m.doi.trim().toLowerCase()).filter(Boolean))
            .size > 1
    )
        warnings.push("Conflicting DOIs: verify these are the same work.");
    const ranked = [...members].sort(
        (a, b) =>
            b.attachment_count +
                b.note_count -
                (a.attachment_count + a.note_count) ||
            a.date_added.localeCompare(b.date_added) ||
            a.item_id.localeCompare(b.item_id),
    );
    return {
        group_id: members
            .map((m) => m.item_id)
            .sort()
            .join(":"),
        members,
        differing_fields,
        warnings,
        mergeable,
        recommended_master_item_id: ranked[0].item_id,
    };
}

/** Use Zotero's detector and release the temporary search table even on failure. */
async function nativeGroups(libraryID: number): Promise<number[][]> {
    const detector = new (Zotero as any).Duplicates(libraryID);
    const search = await detector.getSearchObject();
    const conditions = Object.values(search.getConditions()) as {
        condition: string;
        value: string;
    }[];
    const table = conditions.find((c) => c.condition === "tempTable")?.value;
    try {
        const ids: number[] = (await search.search()) || [];
        const seen = new Set<number>();
        const groups: number[][] = [];
        for (const id of ids) {
            if (seen.has(id)) continue;
            const group: number[] = detector.getSetItemsByItemID(id);
            group.forEach((i) => seen.add(i));
            if (group.length > 1) groups.push(group);
        }
        return groups;
    } finally {
        if (table && /^tmpDuplicates_[a-zA-Z0-9]+$/.test(table))
            await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${table}`);
    }
}
export async function handleDuplicatesRequest(
    request: DuplicatesRequest,
): Promise<DuplicatesResponse> {
    const empty: DuplicatesResponse = {
        type: "duplicates",
        request_id: request.request_id,
        view_type: "duplicates",
        mode: request.mode,
        groups: [],
        total_count: 0,
        has_more: false,
        next_offset: null,
        snapshot_id: "",
    };
    try {
        const scope = validateLibraryAccess(request.library);
        if (!scope.valid) throw duplicateError(scope.error!, scope.error_code);
        const libraryID = scope.library!.libraryID;
        let population = await nativeGroups(libraryID);
        if (request.collection) {
            const collection = getCollectionByIdOrName(
                request.collection,
                libraryID,
            );
            if (!collection || collection.libraryID !== libraryID)
                throw duplicateError(
                    "Collection not found in the requested library.",
                    "collection_not_found",
                );
            const search = new Zotero.Search();
            (search as any).libraryID = libraryID;
            search.addCondition("collection", "is", collection.collection.key);
            search.addCondition("recursive", "true");
            const scopeIDs = new Set<number>((await search.search()) || []);
            population = population.filter((group) =>
                group.some((id) => scopeIDs.has(id)),
            );
        }
        const loadedGroups = await Promise.all(
            population.map(async (ids) => {
                const items = await Zotero.Items.getAsync(ids);
                return items
                    .filter((i) => i && !i.deleted)
                    .sort((a, b) => a.key.localeCompare(b.key));
            }),
        );
        const groups = loadedGroups.filter((g) => g.length > 1);
        groups.sort((a, b) => a[0].key.localeCompare(b[0].key));
        const signature = stableJSON([
            libraryRefForLibraryID(libraryID),
            request.collection ?? null,
            groups.map((g) => g.map((i) => i.key)),
        ]);
        const snapshot_id = Zotero.Utilities.Internal.md5(signature);
        const offset = Math.max(0, Math.trunc(request.offset || 0));
        const limit = Math.max(
            1,
            Math.min(25, Math.trunc(request.limit || 10)),
        );
        if (offset && !request.snapshot_id)
            throw duplicateError(
                "Pass snapshot_id from the first page when using offset.",
                "snapshot_required",
            );
        if (request.snapshot_id && request.snapshot_id !== snapshot_id)
            throw duplicateError(
                "Duplicate groups changed. Restart find_duplicates at offset 0.",
                "stale_snapshot",
            );
        const page = await Promise.all(
            groups
                .slice(offset, offset + limit)
                .map((g) => describeGroup(g)),
        );
        const excluded = checkLibraryExcluded(libraryID);
        if (excluded)
            throw duplicateError(excluded.message, "library_excluded");
        const has_more = offset + limit < groups.length;
        return {
            ...empty,
            groups: page,
            total_count: groups.length,
            has_more,
            next_offset: has_more ? offset + limit : null,
            snapshot_id,
        };
    } catch (error: any) {
        return {
            ...empty,
            error: error.message || String(error),
            error_code: error.code || "duplicate_detection_failed",
        };
    }
}
