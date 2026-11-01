import {
    validateArtifactRequest,
    type ArtifactRequest,
    type ArtifactResponse,
    type ArtifactListEntry,
} from "@beaver/agent-core/protocol/artifactProtocol";
import {
    readSpec,
    validateTableSpec,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { applyMutations, summarize } from "@beaver/agent-core/layouts/tableMutations";
import { pendingWork } from "@beaver/agent-core/layouts/tableFill";
import {
    applyEdit,
    buildTable,
    columnFromDraft,
    previewFacts,
    refreshTargets,
    systemColumns,
    type ResolvedSource,
} from "@beaver/agent-core/layouts/tableEdit";
import type { SourceEntry } from "@beaver/agent-core/layouts/table";
import type {
    TableColumnDraft,
    TableEditOperations,
} from "@beaver/agent-core/protocol/tableEditProtocol";
import type { AgentDataRequestContext } from "@beaver/agent-core/transport/agentDataDispatch";
import {
    parseItemReference,
    resolveLibraryRef,
    libraryRefForLibraryID,
} from "../../utils/libraryIdentity";
import { checkLibraryExcluded } from "../agentDataProvider/utils";
import {
    applyTableEditUncoordinated as applyTableEdit,
    createTableFromRequestUncoordinated as createTableFromRequest,
    openTableUncoordinated as openTable,
    revertTableUncoordinated as revertTable,
    tableOperationHash,
    trimTableUncoordinated as trimTable,
    deleteTableUncoordinated as deleteTable,
    type TableWriteMeta,
} from "./tableStore";
import { resolveSource, resolveSources } from "./tableSources";
import { TableItemError, type TableRef, type TableVersionEntry } from "./tableItemIdentity";
import type { MutationOptions } from '../libraryMutations';

/** No content or device-local identifiers in provider failure prose. */
export function artifactFailure(
    raw: unknown,
    code = "operation_failed",
): ArtifactResponse {
    const request = raw as Partial<ArtifactRequest> | null;
    return {
        type: "artifact_response",
        request_id: request?.request_id ?? "",
        op: request?.op ?? "",
        ok: false,
        conflict: false,
        error_code: code,
        error: `Table operation unavailable (${code}).`,
    };
}

function checkLibrary(libraryID: number | null): asserts libraryID is number {
    if (libraryID == null)
        throw new TableItemError("Library unavailable.", "unsupported_library");
    if (checkLibraryExcluded(libraryID))
        throw new TableItemError("Table unavailable.", "library_excluded");
}

/** Inspect structured identities and citation tags, including resolved and raw references. */
export function checkTableAccess(
    spec: TableSpec,
    inspectLibrary: (id: number | null) => void = checkLibrary,
): void {
    visitLibraryReferences(spec, inspectLibrary);
}

/**
 * Calls `inspectLibrary` with the local library of every Zotero reference in
 * `value`: item ids in text (`u-KEY`, `g<id>-KEY`), legacy citation tags'
 * library numbers, and structured `library_ref` / `library_id` fields. Null
 * for a reference to a library this device does not have.
 */
export function visitLibraryReferences(
    value: unknown,
    inspectLibrary: (id: number | null) => void,
): void {
    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            for (const match of value.matchAll(
                /\b(?:u|g[1-9]\d*|[1-9]\d*)-[A-Z0-9]{8}\b/g,
            )) {
                const ref = parseItemReference(match[0]);
                if (ref) inspectLibrary(resolveLibraryRef(ref));
            }
            // Legacy citation tags may still carry this device's library number.
            for (const match of value.matchAll(
                /\blibrary_id\s*=\s*["']?(\d+)/g,
            ))
                inspectLibrary(Number(match[1]));
            return;
        }
        if (!value || typeof value !== "object") return;
        const ref = value as { library_ref?: string; library_id?: number };
        if (
            ref.library_ref ||
            (typeof ref.library_id === "number" && ref.library_id >= 0)
        )
            inspectLibrary(resolveLibraryRef(ref));
        for (const nested of Object.values(value)) visit(nested);
    };
    visit(value);
}

/** A refusal whose text names the parameter and its index; it carries no table content. */
function editFailure(raw: unknown, code: string, message: string): ArtifactResponse {
    return { ...artifactFailure(raw, code), error: message };
}

/**
 * The question columns of a proposal, checked as the engine adds them; a
 * refusal names the column.
 */
function checkColumns(drafts: readonly TableColumnDraft[]): { code: string; message: string } | null {
    const taken = new Set(systemColumns().map((column) => column.id));
    const columns = drafts.map((draft) => {
        const column = columnFromDraft(draft, taken);
        taken.add(column.id);
        return column;
    });
    const checked = applyMutations({ id: "check", columns: [], rows: [] }, [{ op: "add_columns", columns }]);
    if (checked.ok) return null;
    return { code: checked.error.code === "too_large" ? "too_large" : "invalid_edit", message: `columns: ${checked.error.message}` };
}

/**
 * Checks a change list against the libraries Beaver may read (a replay may
 * describe a source of a library excluded since). The ids an items entry
 * rejected are left out: an excluded item is rejected by design, and its id
 * is the caller's own.
 */
function checkChanges(changes: unknown): void {
    const visible = (changes as Record<string, unknown>[] | undefined ?? []).map(({ rejected: _rejected, ...rest }) => rest);
    visitLibraryReferences(visible, checkLibrary);
}

/**
 * A version entry as it leaves the device: without the change list and the
 * operation identity an edit recorded for its replay, which may name a source
 * of a library excluded since.
 */
function remoteEntry(entry: TableVersionEntry): TableVersionEntry {
    const { changes: _changes, operation_id: _id, request_sha256: _sha, ...rest } = entry;
    return rest;
}

/** Whether every library a resolved source names is still one Beaver may read. */
function readable(source: ResolvedSource): boolean {
    try {
        visitLibraryReferences({ entry: source.entry, papers: source.papers }, checkLibrary);
        return true;
    } catch {
        return false;
    }
}

function todayOf(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/** Retain the libraries inspected through async history reads for a final policy check. */
function accessFor(libraryID: number) {
    const libraries = new Set<number>([libraryID]);
    return (spec?: TableSpec): void => {
        if (spec)
            checkTableAccess(spec, (id) => {
                checkLibrary(id);
                libraries.add(id);
            });
        for (const id of libraries) checkLibrary(id);
    };
}

function target(key: string): TableRef {
    const parsed = parseItemReference(key)!;
    const libraryID = resolveLibraryRef(parsed);
    checkLibrary(libraryID);
    return { libraryID, key: parsed.zotero_key };
}
function itemIdentity(ref: TableRef) {
    return {
        library_id: ref.libraryID,
        library_ref: libraryRefForLibraryID(ref.libraryID)!,
        zotero_key: ref.key,
    };
}
function errorCode(error: unknown): string {
    const code = (error as { code?: string })?.code;
    return code === "file_missing"
        ? "item_missing"
        : (code ?? "operation_failed");
}
function content(raw: unknown): TableSpec {
    const parsed = readSpec(raw);
    if (!parsed.ok)
        throw new TableItemError(
            "Invalid table.",
            parsed.reason === "unsupported_version"
                ? "unsupported_version"
                : "invalid_spec",
        );
    try {
        if (validateTableSpec(parsed.spec).length)
            throw new Error("Invalid table");
    } catch {
        throw new TableItemError("Invalid table.", "invalid_spec");
    }
    checkTableAccess(parsed.spec);
    return parsed.spec;
}

/**
 * Executes access checks and table work in the plugin realm under one queue
 * admission. `fill_plan` and `fill` are not table writes and take no
 * admission: a fill job commits through the queue one commit at a time, and a
 * waiting `fill` must not hold it.
 */
export async function handleArtifactRequest(
    raw: unknown,
    options?: MutationOptions & Partial<AgentDataRequestContext>,
): Promise<ArtifactResponse> {
    const invalid = validateArtifactRequest(raw);
    if (invalid) return artifactFailure(raw, invalid);
    const request = raw as ArtifactRequest;
    if (request.op === "fill_plan" || request.op === "fill")
        return handleFillRequest(request, options);
    if (request.op === "preview") return handlePreviewRequest(request);
    try {
        return await Zotero.Beaver.libraryOperations.run('artifact_request', [raw], options);
    } catch (error) {
        return artifactFailure(raw, errorCode(error));
    }
}

/** The fill operations, served by the plugin's fill service. */
async function handleFillRequest(
    request: ArtifactRequest,
    context?: Partial<AgentDataRequestContext>,
): Promise<ArtifactResponse> {
    const fills = Zotero.Beaver?.tableFills;
    if (!fills)
        return {
            ...artifactFailure(request, "signed_out"),
            error: "Sign in to Beaver to fill tables.",
        };
    try {
        if (request.op === "fill_plan") {
            const ref = target(request.key!);
            return await fills.agent.plan(request, ref);
        }
        return await fills.agent.fill(request, context as AgentDataRequestContext | undefined);
    } catch (error) {
        return artifactFailure(request, errorCode(error));
    }
}

/**
 * `preview`: what a proposal's sources give, through the same resolver and
 * merge as `create`. Not a write: it takes no queue admission and writes
 * nothing. A source that cannot be used comes back with its `error`.
 */
async function handlePreviewRequest(request: ArtifactRequest): Promise<ArtifactResponse> {
    try {
        const columns = (request.columns ?? []) as TableColumnDraft[];
        const refused = checkColumns(columns);
        if (refused) return editFailure(request, refused.code, refused.message);
        // Exclusions may change while the sources resolve: a source that now
        // touches a library Beaver may not read comes back as unusable, with
        // nothing of its content.
        const asked = request.sources as SourceEntry[];
        const resolved = (await resolveSources(asked)).map((source, index) =>
            readable(source)
                ? source
                : {
                      // The entry as it was asked for: nothing resolved from
                      // the library (a name, the papers) leaves the device.
                      entry: asked[index],
                      papers: [],
                      total: 0,
                      truncated: false,
                      rejected: [],
                      error: "This library is not available to Beaver.",
                  },
        );
        return {
            type: "artifact_response",
            request_id: request.request_id,
            op: request.op,
            ok: true,
            preview: previewFacts(resolved),
        };
    } catch (error) {
        return artifactFailure(request, errorCode(error));
    }
}

/** Already coordinated by the instance; table helpers must not re-enter its queue. */
export async function handleArtifactRequestUncoordinated(
    raw: unknown,
): Promise<ArtifactResponse> {
    const invalid = validateArtifactRequest(raw);
    if (invalid) return artifactFailure(raw, invalid);
    const request = raw as ArtifactRequest;
    const success = (result: Partial<ArtifactResponse>): ArtifactResponse => ({
        type: "artifact_response",
        request_id: request.request_id,
        op: request.op,
        ok: true,
        ...result,
    });
    try {
        const meta = Object.fromEntries(
            Object.entries(request.meta ?? {}).filter(
                ([, value]) => value != null,
            ),
        ) as unknown as TableWriteMeta;
        if (request.op === "list") {
            const items: ArtifactListEntry[] = [];
            const checks: Array<(() => void) | undefined> = [];
            for (const key of request.keys!) {
                checks.push(undefined);
                try {
                    const ref = target(key);
                    const guard = accessFor(ref.libraryID);
                    checks[checks.length - 1] = guard;
                    const opened = await openTable(ref, guard);
                    checkLibrary(ref.libraryID);
                    content(opened.spec);
                    guard(opened.spec);
                    const own = opened.history.filter(
                        (entry) => entry.thread_id === request.thread_id,
                    );
                    const seen = Math.max(
                        0,
                        ...own.map((entry) => entry.version),
                    );
                    items.push({
                        key,
                        kind: "table",
                        unavailable: false,
                        title: opened.spec.title ?? "",
                        zotero_item: itemIdentity(ref),
                        version: opened.version,
                        sha256: opened.sha256,
                        summary: summarize(opened.spec),
                        unseen: request.thread_id
                            ? opened.history.map(remoteEntry).filter(
                                  (entry) => entry.version > seen,
                              )
                            : [],
                    });
                } catch (error) {
                    items.push({
                        key,
                        kind: "table",
                        unavailable: true,
                        error_code: errorCode(error),
                        unseen: [],
                    });
                }
            }
            for (let index = 0; index < items.length; index++) {
                if (items[index].unavailable) continue;
                try {
                    checks[index]?.();
                } catch (error) {
                    items[index] = {
                        key: items[index].key,
                        kind: "table",
                        unavailable: true,
                        error_code: errorCode(error),
                        unseen: [],
                    };
                }
            }
            return success({ items });
        }
        if (request.op === "create") {
            const libraryID = resolveLibraryRef({
                library_ref: request.library_ref,
            });
            checkLibrary(libraryID);
            const guard = accessFor(libraryID);
            const columns = (request.columns ?? []) as TableColumnDraft[];
            const sources = request.sources as SourceEntry[];
            const created = await createTableFromRequest({
                libraryID,
                // Resolved by the store after its replay check.
                ...(request.collection_key ? { collectionKey: request.collection_key } : {}),
                title: request.title!,
                operation_id: request.operation_id!,
                request: {
                    title: request.title,
                    description: request.description ?? null,
                    sources,
                    columns,
                    meta: request.meta,
                },
                ...meta,
                accessGuard: guard,
                // Runs only for a new table: a replay never resolves again.
                build: async () =>
                    buildTable(
                        {
                            id: `t${Date.now().toString(36)}`,
                            title: request.title!,
                            description: request.description,
                            columns,
                        },
                        await resolveSources(sources),
                        todayOf(new Date()),
                    ),
            });
            if ("ok" in created && created.ok === false)
                return editFailure(request, created.code, created.message);
            const table = created as Exclude<typeof created, { ok: false }>;
            checkLibrary(libraryID);
            guard(table.spec);
            checkChanges(table.changes);
            return success({
                version: table.version,
                sha256: table.sha256,
                spec: table.spec,
                summary: summarize(table.spec),
                pending: pendingWork(table.spec),
                zotero_item: itemIdentity({ libraryID, key: table.key }),
                changes: table.changes as ArtifactResponse["changes"],
                replayed: table.replayed ?? false,
                saved: table.saved !== false,
            });
        }
        const ref = target(request.key!);
        const guard = accessFor(ref.libraryID);
        // Reads validate the file under the store lock; mutation guards repeat there.
        if (request.op === "read" || request.op === "versions") {
            const opened = await openTable(ref, guard);
            checkLibrary(ref.libraryID);
            content(opened.spec);
            guard(opened.spec);
            return request.op === "versions"
                ? success({ versions: opened.history.map(remoteEntry) })
                : success({
                      version: opened.version,
                      sha256: opened.sha256,
                      spec: opened.spec,
                      summary: summarize(opened.spec),
                      pending: pendingWork(opened.spec),
                  });
        }
        if (request.op === "delete") {
            await deleteTable(ref);
            return success({ saved: true });
        }
        if (request.op === "trim") {
            const result = await trimTable(
                ref,
                { thread_id: request.thread_id!, run_ids: request.run_ids! },
                guard,
            );
            guard();
            return success(result);
        }
        if (request.op === "apply_edit") return await applyEditRequest(request, ref, guard, meta, success);
        const result = await revertTable(ref, request.to_version!, meta, guard);
        checkLibrary(ref.libraryID);
        guard(result.spec ?? undefined);
        if (!result.ok) {
            if (!result.spec || !result.sha256)
                return artifactFailure(request, "corrupt");
            return {
                ...artifactFailure(request, "conflict"),
                conflict: true,
                spec: result.spec,
                version: result.version,
                sha256: result.sha256,
            };
        }
        return success({
            version: result.version,
            sha256: result.sha256,
            spec: result.spec,
            summary: summarize(result.spec),
            pending: pendingWork(result.spec),
            saved: result.saved,
        });
    } catch (error) {
        return artifactFailure(request, errorCode(error));
    }
}

/**
 * `apply_edit`: one `edit_table` call as one sealed write. Sources to add or
 * refresh are resolved first, outside the table's lock; the engine then
 * applies the whole call to the table as it stands under the lock, all of it
 * or nothing. A repeat with the same operation id answers from the version it
 * committed.
 */
async function applyEditRequest(
    request: ArtifactRequest,
    ref: TableRef,
    guard: ReturnType<typeof accessFor>,
    meta: TableWriteMeta,
    success: (result: Partial<ArtifactResponse>) => ArtifactResponse,
): Promise<ArtifactResponse> {
    const operations = request.operations as TableEditOperations;
    const request_sha256 = await tableOperationHash({ key: request.key, operations, meta: request.meta });
    const added: ResolvedSource[] = [];
    for (const draft of operations.add_sources ?? [])
        added.push(await resolveSource({ ...draft, id: "new" } as SourceEntry));
    const refreshed = new Map<string, ResolvedSource>();
    if (operations.refresh_sources != null) {
        const opened = await openTable(ref, guard);
        for (const entry of refreshTargets(opened.spec, operations.refresh_sources))
            refreshed.set(entry.id, await resolveSource(entry));
    }
    const now = new Date().toISOString();
    const result = await applyTableEdit(
        ref,
        (spec) => applyEdit(spec, operations, { added, refreshed }, now),
        { ...meta, seal: true },
        { operation_id: request.operation_id!, request_sha256 },
        guard,
    );
    if (!result.ok) return editFailure(request, result.code, result.message);
    checkLibrary(ref.libraryID);
    guard(result.spec);
    checkChanges(result.changes);
    return success({
        version: result.version,
        sha256: result.sha256,
        spec: result.spec,
        summary: summarize(result.spec),
        pending: pendingWork(result.spec),
        changes: result.changes as ArtifactResponse["changes"],
        replayed: result.replayed,
        saved: result.saved,
    });
}
