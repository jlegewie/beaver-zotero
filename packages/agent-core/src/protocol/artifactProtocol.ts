import type { TableSpec } from "../layouts/table";
import type { TableSummary } from "../layouts/tableMutations";

/** Portable stored-document provider envelopes. Optional nulls are wire defaults. */
export interface ArtifactRequest {
    event: "artifact_request";
    request_id: string;
    op: string;
    key?: string | null;
    keys?: string[] | null;
    kind?: "table" | null;
    library_ref?: string | null;
    title?: string | null;
    spec?: Record<string, unknown> | null;
    meta?: {
        actor: "agent" | "user" | "system";
        run_id?: string | null;
        thread_id?: string | null;
        change?: string | null;
    } | null;
    operation_id?: string | null;
    expected_version?: number | null;
    expected_sha256?: string | null;
    to_version?: number | null;
    thread_id?: string | null;
    run_ids?: string[] | null;
}

export interface ArtifactVersion {
    version: number;
    actor: "agent" | "user" | "system";
    run_id?: string;
    thread_id?: string;
    change?: string;
    at: string;
    sha256: string;
    summary: TableSummary;
    sealed?: boolean;
    creation?: boolean;
}
export interface ArtifactOperationReceipt {
    operation_id: string;
    request_sha256: string;
    version: number;
    sha256: string;
}
export interface ArtifactItem {
    library_id: number;
    library_ref: string;
    zotero_key: string;
}
export type ArtifactListEntry = {
    key: string;
    kind: "table";
    unseen: ArtifactVersion[];
} & (
    | { unavailable: true; error_code: string }
    | {
          unavailable: false;
          title: string;
          zotero_item: ArtifactItem;
          version: number;
          sha256: string;
          summary: TableSummary;
      }
);
export interface ArtifactResponse {
    type: "artifact_response";
    request_id: string;
    op: string;
    ok: boolean;
    conflict?: boolean;
    error_code?: string;
    error?: string;
    version?: number;
    sha256?: string;
    spec?: TableSpec;
    summary?: TableSummary;
    versions?: ArtifactVersion[];
    items?: ArtifactListEntry[];
    zotero_item?: ArtifactItem;
    operation?: ArtifactOperationReceipt;
    replayed?: boolean;
    saved?: boolean;
    outcome?: "unchanged" | "trimmed" | "trashed";
    trimmed_versions?: number[];
    trimmed_to?: number | null;
    retention_exhausted?: boolean;
}

const contracts: Record<string, [string[], string[]]> = {
    list: [["keys"], ["kind", "thread_id"]],
    read: [["key"], []],
    versions: [["key"], []],
    create: [
        ["kind", "library_ref", "title", "spec", "meta", "operation_id"],
        [],
    ],
    write: [
        [
            "key",
            "spec",
            "meta",
            "expected_version",
            "expected_sha256",
            "operation_id",
        ],
        [],
    ],
    revert: [["key", "to_version", "meta"], []],
    trim: [["key", "thread_id", "run_ids"], []],
    delete: [["key"], []],
};
const handle = /^(u|g[1-9]\d*)-[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const nonempty = (value: unknown): value is string =>
    typeof value === "string" && !!value.trim();
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

/** Refuse malformed envelopes before touching identity, content, or receipts. */
export function validateArtifactRequest(
    raw: unknown,
): "invalid_request" | "unsupported_op" | null {
    if (
        !object(raw) ||
        raw.event !== "artifact_request" ||
        !nonempty(raw.request_id) ||
        !nonempty(raw.op)
    )
        return "invalid_request";
    if (!Object.hasOwnProperty.call(contracts, raw.op)) return "unsupported_op";
    const [required, optional] = contracts[raw.op];
    const fields = new Set(
        Object.values(contracts).flatMap(([r, o]) => [...r, ...o]),
    );
    for (const [name, value] of Object.entries(raw)) {
        if (["event", "request_id", "op"].includes(name)) continue;
        if (
            !fields.has(name) ||
            (value != null &&
                !required.includes(name) &&
                !optional.includes(name))
        )
            return "invalid_request";
    }
    if (required.some((name) => raw[name] == null)) return "invalid_request";
    if (
        raw.key != null &&
        (typeof raw.key !== "string" || !handle.test(raw.key))
    )
        return "invalid_request";
    if (
        raw.keys != null &&
        (!Array.isArray(raw.keys) ||
            raw.keys.length > 200 ||
            new Set(raw.keys).size !== raw.keys.length ||
            raw.keys.some(
                (key) => typeof key !== "string" || !handle.test(key),
            ))
    )
        return "invalid_request";
    if (raw.kind != null && raw.kind !== "table") return "invalid_request";
    if (
        raw.library_ref != null &&
        (typeof raw.library_ref !== "string" ||
            !/^(u|g[1-9]\d*)$/.test(raw.library_ref))
    )
        return "invalid_request";
    for (const name of ["thread_id", "operation_id"])
        if (raw[name] != null && !nonempty(raw[name])) return "invalid_request";
    for (const name of ["expected_version", "to_version"])
        if (
            raw[name] != null &&
            (!Number.isSafeInteger(raw[name]) || (raw[name] as number) < 1)
        )
            return "invalid_request";
    if (
        raw.expected_sha256 != null &&
        (typeof raw.expected_sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(raw.expected_sha256))
    )
        return "invalid_request";
    if (
        raw.run_ids != null &&
        (!Array.isArray(raw.run_ids) || !raw.run_ids.every(nonempty))
    )
        return "invalid_request";
    if (raw.title != null && typeof raw.title !== "string")
        return "invalid_request";
    if (raw.spec != null && !object(raw.spec)) return "invalid_request";
    if (raw.meta != null) {
        if (
            !object(raw.meta) ||
            !["agent", "user", "system"].includes(raw.meta.actor as string)
        )
            return "invalid_request";
        if (
            Object.keys(raw.meta).some(
                (key) =>
                    !["actor", "run_id", "thread_id", "change"].includes(key),
            )
        )
            return "invalid_request";
        for (const name of ["run_id", "thread_id"])
            if (raw.meta[name] != null && !nonempty(raw.meta[name]))
                return "invalid_request";
        if (raw.meta.change != null && typeof raw.meta.change !== "string")
            return "invalid_request";
        if (
            raw.meta.actor === "agent" &&
            (!nonempty(raw.meta.run_id) || !nonempty(raw.meta.thread_id))
        )
            return "invalid_request";
    }
    return null;
}
