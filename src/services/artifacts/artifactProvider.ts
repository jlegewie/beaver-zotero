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
import { summarize } from "@beaver/agent-core/layouts/tableMutations";
import {
    parseItemReference,
    resolveLibraryRef,
    libraryRefForLibraryID,
} from "../../utils/libraryIdentity";
import { checkLibraryExcluded } from "../agentDataProvider/utils";
import {
    createTableUncoordinated as createTable,
    writeTableUncoordinated as writeTable,
    openTableUncoordinated as openTable,
    revertTableUncoordinated as revertTable,
    trimTableUncoordinated as trimTable,
    deleteTableUncoordinated as deleteTable,
    type TableWriteMeta,
} from "./tableStore";
import { TableItemError, type TableRef } from "./tableItemIdentity";
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
    visit(spec);
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

/** Executes access checks and table work in the plugin realm under one queue admission. */
export async function handleArtifactRequest(
    raw: unknown,
    options?: MutationOptions,
): Promise<ArtifactResponse> {
    const invalid = validateArtifactRequest(raw);
    if (invalid) return artifactFailure(raw, invalid);
    try {
        return await Zotero.Beaver.libraryOperations.run('artifact_request', [raw], options);
    } catch (error) {
        return artifactFailure(raw, errorCode(error));
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
                            ? opened.history.filter(
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
            const created = await createTable({
                libraryID,
                title: request.title!,
                spec: content(request.spec),
                ...meta,
                operation_id: request.operation_id!,
                accessGuard: guard,
            });
            checkLibrary(libraryID);
            guard(created.spec);
            return success({
                version: created.version,
                sha256: created.sha256,
                spec: created.spec,
                summary: summarize(created.spec),
                zotero_item: itemIdentity({ libraryID, key: created.key }),
                operation: created.operation,
                replayed: created.replayed ?? false,
                saved: true,
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
                ? success({ versions: opened.history })
                : success({
                      version: opened.version,
                      sha256: opened.sha256,
                      spec: opened.spec,
                      summary: summarize(opened.spec),
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
        const result =
            request.op === "write"
                ? await writeTable(
                      ref,
                      content(request.spec),
                      meta,
                      request.expected_version!,
                      {
                          expected_sha256: request.expected_sha256!,
                          operation_id: request.operation_id!,
                          accessGuard: guard,
                      },
                  )
                : await revertTable(ref, request.to_version!, meta, guard);
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
            saved: result.saved,
            ...(result.operation ? { operation: result.operation } : {}),
            replayed: result.replayed ?? false,
        });
    } catch (error) {
        return artifactFailure(request, errorCode(error));
    }
}
