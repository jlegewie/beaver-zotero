import { useSurfaceWindow } from "../../runtime/SurfaceWindowContext";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    cellValueText,
    toCsv,
    type Cell,
    type CellValue,
    type ColumnType,
    validateTableSpec,
} from "@beaver/agent-core/layouts/table";
import {
    applyMutations,
    type TableMutation,
} from "@beaver/agent-core/layouts/tableMutations";
import {
    editTable,
    openTable,
    revertTable,
    TABLE_UPDATED_EVENT,
    type OpenTableResult,
} from "../../../src/services/artifacts/tableStore";
import { getWindowRuntime } from "../../runtime/windowRuntime";
import type { TableWindowSurface } from "../../atoms/windowSurface";
import { TableSnapshotView } from "./TableWindowView";
import { getTablesApi } from "../../../src/services/artifacts/tablesApi";
import MarkdownRenderer from "../messages/MarkdownRenderer";

/** Editable payload, excluding labels, units and bibliographic context. */
function correctionText(value?: CellValue): string {
    if (!value) return "";
    switch (value.kind) {
        case "text":
            return value.text;
        case "annotation":
            return value.text ?? "";
        case "reference":
            return value.display_name;
        case "link":
            return value.url;
        case "select":
            return value.label;
        default:
            return String(value.value);
    }
}

type DraftSection = "cell" | "column" | "meta";

/** One store-backed editor. Extraction remains an optional composer integration. */
export default function StoredTableEditor({
    surface,
    onRequestFill,
}: {
    surface: TableWindowSurface;
    onRequestFill?: (
        ref: NonNullable<TableWindowSurface["ref"]>,
        row: string,
        column: string,
    ) => void;
}): React.ReactElement {
    const ref = surface.ref!;
    const surfaceWindow = useSurfaceWindow();
    const [snapshot, setSnapshot] = useState<OpenTableResult>();
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [rowId, setRowId] = useState("");
    const [columnId, setColumnId] = useState("");
    const [value, setValue] = useState("");
    const [evidence, setEvidence] = useState("");
    const [title, setTitle] = useState("");
    const [question, setQuestion] = useState("");
    const [header, setHeader] = useState("");
    const [unit, setUnit] = useState("");
    const [options, setOptions] = useState("");
    const [caption, setCaption] = useState("");
    const [newHeader, setNewHeader] = useState("");
    const [newType, setNewType] = useState<ColumnType>("text");
    const [version, setVersion] = useState("");
    const alive = useRef(true);
    const generation = useRef(0);
    const dirty = useRef(new Set<DraftSection>());
    const saving = useRef(false);
    const reload = useCallback(
        async (
            explicit = false,
            savedSections?: DraftSection[],
            savedRevision?: { version?: number; sha256?: string },
        ) => {
            const token = ++generation.current;
            try {
                const next = await openTable(ref);
                if (!alive.current || token !== generation.current) return;
                if (
                    (dirty.current.size && !explicit && !savedSections) ||
                    (savedSections &&
                        dirty.current.size &&
                        savedRevision?.sha256 &&
                        (next.sha256 !== savedRevision.sha256 ||
                            next.version !== savedRevision.version))
                ) {
                    setMessage(
                        "The table changed. Your draft is preserved; reload before saving.",
                    );
                    return;
                }
                if (explicit) dirty.current.clear();
                else
                    savedSections?.forEach((section) =>
                        dirty.current.delete(section),
                    );
                setSnapshot(next);
                if (!dirty.current.has("meta")) {
                    setTitle(next.spec.title ?? "");
                    setCaption(next.spec.caption ?? "");
                }
                setMessage(
                    next.conflict
                        ? "A synced copy displaced local work. The retained local version is available in the item pane."
                        : next.recovered.length
                          ? "Recovered interrupted table bookkeeping."
                          : "",
                );
            } catch (error) {
                if (alive.current) setMessage(String(error));
            }
        },
        [ref.libraryID, ref.key],
    );
    useEffect(() => {
        alive.current = true;
        void reload();
        const runtime = getWindowRuntime();
        const unsubscribe = Zotero.Beaver.runtime.subscribeWindow(
            runtime,
            TABLE_UPDATED_EVENT,
            (detail) => {
                if (
                    detail.libraryID === ref.libraryID &&
                    detail.key === ref.key
                )
                    if (!saving.current) void reload();
            },
        );
        const observer = Zotero.Notifier.registerObserver(
            {
                notify: () => {
                    if (!saving.current) void reload();
                },
            },
            ["item"],
            "beaver-table-editor",
        );
        return () => {
            alive.current = false;
            generation.current++;
            unsubscribe();
            Zotero.Notifier.unregisterObserver(observer);
        };
    }, [reload]);
    const table = snapshot?.spec;
    const column = table?.columns.find((entry) => entry.id === columnId);
    const cell = table?.rows.find((entry) => entry.id === rowId)?.cells[
        columnId
    ];
    useEffect(() => {
        if (dirty.current.has("cell")) return;
        setValue(correctionText(cell?.value));
        setEvidence(
            cell?.details?.kind === "text"
                ? cell.details.text
                : (cell?.details?.items.join("\n") ?? ""),
        );
    }, [snapshot, rowId, columnId]);
    useEffect(() => {
        if (dirty.current.has("column")) return;
        setQuestion(column?.description ?? "");
        setHeader(column?.header ?? "");
        setUnit(column?.unit ?? "");
        setOptions(
            column?.options?.map((option) => option.label).join("\n") ?? "",
        );
    }, [snapshot, columnId]);
    const run = async (
        action: () => Promise<{
            ok: boolean;
            saved?: boolean;
            error?: unknown;
            version?: number;
            sha256?: string | null;
        }>,
        savedSections: DraftSection[] = [],
    ) => {
        if (busy) return;
        setBusy(true);
        saving.current = true;
        try {
            const result = await action();
            if (!alive.current) return;
            if (!result.ok) {
                setMessage(
                    "The edit was refused. Reload to review current content before trying again.",
                );
                return;
            }
            await reload(false, savedSections, {
                version: result.version,
                sha256: result.sha256 ?? undefined,
            });
            if (result.saved === false)
                setMessage(
                    "Content saved; sync bookkeeping needs repair. Reopen the table to retry repair.",
                );
        } catch (error) {
            if (alive.current) setMessage(String(error));
        } finally {
            saving.current = false;
            if (alive.current) setBusy(false);
        }
    };
    const mutate = (
        mutations: TableMutation[],
        savedSections: DraftSection[] = [],
    ) => {
        if (!snapshot) return;
        const preview = applyMutations(snapshot.spec, mutations);
        if (!preview.ok) {
            setMessage(preview.error.message);
            return;
        }
        const issues = validateTableSpec(preview.spec);
        if (issues.length) {
            setMessage(issues[0].message);
            return;
        }
        return run(
            () =>
                editTable(
                    ref,
                    mutations,
                    { actor: "user" },
                    { version: snapshot.version, sha256: snapshot.sha256 },
                ),
            savedSections,
        );
    };
    const saveCell = (outcome?: "not_reported" | "reset") => {
        if (!column || !rowId) return;
        const next: Cell =
            outcome === "reset"
                ? {}
                : {
                      provenance: "user",
                      ...(evidence
                          ? {
                                details: {
                                    kind: "text",
                                    text: evidence,
                                } as const,
                            }
                          : {}),
                  };
        if (outcome === "not_reported") next.outcome = outcome;
        else if (
            !outcome &&
            cell?.value &&
            value === correctionText(cell.value)
        ) {
            next.value = cell.value;
        } else if (!outcome && value !== "") {
            switch (column.type) {
                case "number":
                    if (!Number.isFinite(Number(value))) {
                        setMessage("Enter a finite number.");
                        return;
                    }
                    next.value = { kind: "number", value: Number(value) };
                    break;
                case "boolean":
                    if (!["true", "false"].includes(value)) {
                        setMessage("Enter true or false.");
                        return;
                    }
                    next.value = { kind: "boolean", value: value === "true" };
                    break;
                case "select":
                    next.value = { kind: "select", label: value };
                    break;
                case "date":
                    next.value = { kind: "date", value };
                    break;
                case "link":
                    next.value = {
                        ...(cell?.value?.kind === "link" ? cell.value : {}),
                        kind: "link",
                        url: value,
                    };
                    break;
                case "reference":
                    next.value =
                        cell?.value?.kind === "annotation"
                            ? { ...cell.value, text: value }
                            : {
                                  ...(cell?.value?.kind === "reference"
                                      ? cell.value
                                      : {}),
                                  kind: "reference",
                                  display_name: value,
                              };
                    break;
                default:
                    next.value = { kind: "text", text: value };
            }
        }
        if (column.role === "screening_decision" && next.value && !evidence) {
            setMessage("A screening decision needs a reason.");
            return;
        }
        void mutate(
            [
                {
                    op: "set_cells",
                    cells: [{ row: rowId, column: columnId, cell: next }],
                },
            ],
            ["cell"],
        );
    };
    const exportCsv = async () => {
        if (!table) return;
        const { FilePicker } = ChromeUtils.importESModule(
            "chrome://zotero/content/modules/filePicker.mjs",
        );
        const picker = new FilePicker();
        picker.init(surfaceWindow, "Export table", picker.modeSave);
        picker.defaultString = `${table.title || "Table"}.csv`;
        picker.appendFilter("CSV", "*.csv");
        if ((await picker.show()) !== picker.returnCancel)
            await IOUtils.writeUTF8(picker.file, toCsv(table));
    };
    return (
        <div className="display-flex flex-col h-full min-h-0">
            <div
                className="p-3 border-bottom-quinary"
                style={{ maxHeight: "45%", overflow: "auto" }}
            >
                {message && <p role="status">{message}</p>}
                <button disabled={busy} onClick={() => void reload(true)}>
                    Reload current table
                </button>{" "}
                <button onClick={() => void getTablesApi()?.openTable(ref)}>
                    Open snapshot
                </button>{" "}
                <button
                    disabled={!table}
                    onClick={() =>
                        void exportCsv().catch((error) =>
                            setMessage(String(error)),
                        )
                    }
                >
                    Export CSV with evidence
                </button>
                <fieldset
                    disabled={busy || !table}
                    style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        alignItems: "center",
                        marginTop: 8,
                    }}
                >
                    <legend>Table and history</legend>
                    <label>
                        Title{" "}
                        <input
                            value={title}
                            onChange={(event) => {
                                dirty.current.add("meta");
                                setTitle(event.target.value);
                            }}
                        />
                    </label>
                    <label>
                        Caption{" "}
                        <input
                            value={caption}
                            onChange={(event) => {
                                dirty.current.add("meta");
                                setCaption(event.target.value);
                            }}
                        />
                    </label>
                    <button
                        onClick={() =>
                            void mutate(
                                [{ op: "set_meta", title, caption }],
                                ["meta"],
                            )
                        }
                    >
                        Save title and caption
                    </button>
                    <select
                        aria-label="Retained version"
                        value={version}
                        onChange={(event) => setVersion(event.target.value)}
                    >
                        <option value="">Choose retained version</option>
                        {snapshot?.history.map((entry) => (
                            <option key={entry.version} value={entry.version}>
                                Version {entry.version} ·{" "}
                                {entry.change ?? entry.actor}
                            </option>
                        ))}
                    </select>
                    <button
                        disabled={!version}
                        onClick={() =>
                            void run(() =>
                                revertTable(ref, Number(version), {
                                    actor: "user",
                                }),
                            )
                        }
                    >
                        Restore selected version
                    </button>
                </fieldset>
                <fieldset
                    disabled={busy || !table}
                    style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        alignItems: "center",
                        marginTop: 8,
                    }}
                >
                    <legend>Edit cell</legend>
                    <select
                        aria-label="Row"
                        value={rowId}
                        onChange={(event) => {
                            dirty.current.delete("cell");
                            setRowId(event.target.value);
                        }}
                    >
                        <option value="">Choose row</option>
                        {table?.rows.map((row) => (
                            <option key={row.id} value={row.id}>
                                {cellValueText(
                                    row.cells[
                                        table.anchor_column_id ??
                                            table.columns[0]?.id
                                    ]?.value,
                                ) || row.id}
                            </option>
                        ))}
                    </select>
                    <select
                        aria-label="Column"
                        value={columnId}
                        onChange={(event) => {
                            dirty.current.delete("cell");
                            dirty.current.delete("column");
                            setColumnId(event.target.value);
                        }}
                    >
                        <option value="">Choose column</option>
                        {table?.columns.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                                {entry.header}
                            </option>
                        ))}
                    </select>
                    <label>
                        Value{" "}
                        <textarea
                            rows={2}
                            value={value}
                            onChange={(event) => {
                                dirty.current.add("cell");
                                setValue(event.target.value);
                            }}
                        />
                    </label>
                    <label>
                        Evidence / reason{" "}
                        <textarea
                            value={evidence}
                            onChange={(event) => {
                                dirty.current.add("cell");
                                setEvidence(event.target.value);
                            }}
                        />
                    </label>
                    {evidence && (
                        <MarkdownRenderer
                            content={evidence}
                            className="markdown"
                        />
                    )}
                    <button
                        disabled={!rowId || !column}
                        onClick={() => saveCell()}
                    >
                        Save correction
                    </button>
                    <button
                        disabled={!rowId || !column}
                        onClick={() => saveCell("not_reported")}
                    >
                        Mark not reported
                    </button>
                    <button
                        disabled={!rowId || !column}
                        onClick={() => saveCell("reset")}
                    >
                        Reset cell and remove protection
                    </button>
                    {onRequestFill && (
                        <button
                            disabled={
                                !rowId || !column || cell?.provenance === "user"
                            }
                            onClick={() => onRequestFill(ref, rowId, columnId)}
                        >
                            Request fill in chat
                        </button>
                    )}
                    <button
                        disabled={!rowId}
                        onClick={() =>
                            void mutate([{ op: "remove_rows", rows: [rowId] }])
                        }
                    >
                        Remove selected row
                    </button>
                </fieldset>
                <fieldset
                    disabled={busy || !table}
                    style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        alignItems: "center",
                        marginTop: 8,
                    }}
                >
                    <legend>Columns and rows</legend>
                    <label>
                        Column header{" "}
                        <input
                            value={header}
                            onChange={(event) => {
                                dirty.current.add("column");
                                setHeader(event.target.value);
                            }}
                        />
                    </label>
                    <label>
                        Column question{" "}
                        <input
                            value={question}
                            onChange={(event) => {
                                dirty.current.add("column");
                                setQuestion(event.target.value);
                            }}
                        />
                    </label>
                    {column?.type === "number" && (
                        <label>
                            Unit{" "}
                            <input
                                value={unit}
                                onChange={(event) => {
                                    dirty.current.add("column");
                                    setUnit(event.target.value);
                                }}
                            />
                        </label>
                    )}
                    {column?.type === "select" && (
                        <label>
                            Options (one per line){" "}
                            <textarea
                                value={options}
                                onChange={(event) => {
                                    dirty.current.add("column");
                                    setOptions(event.target.value);
                                }}
                            />
                        </label>
                    )}
                    <button
                        disabled={!column}
                        onClick={() =>
                            void mutate(
                                [
                                    {
                                        op: "update_column",
                                        column: columnId,
                                        header,
                                        description: question,
                                        ...(column?.type === "number"
                                            ? { unit }
                                            : {}),
                                        ...(column?.type === "select"
                                            ? {
                                                  options: options
                                                      .split("\n")
                                                      .filter((label) =>
                                                          label.trim(),
                                                      )
                                                      .map((label) => ({
                                                          label,
                                                      })),
                                              }
                                            : {}),
                                    },
                                ],
                                ["column"],
                            )
                        }
                    >
                        Save column
                    </button>
                    <button
                        disabled={!column}
                        onClick={() =>
                            void mutate([
                                { op: "remove_columns", columns: [columnId] },
                            ])
                        }
                    >
                        Remove selected column
                    </button>
                    <label>
                        New column{" "}
                        <input
                            value={newHeader}
                            onChange={(event) =>
                                setNewHeader(event.target.value)
                            }
                        />
                    </label>
                    <select
                        aria-label="New column type"
                        value={newType}
                        onChange={(event) =>
                            setNewType(event.target.value as ColumnType)
                        }
                    >
                        {["text", "number", "boolean", "select"].map((type) => (
                            <option key={type}>{type}</option>
                        ))}
                    </select>
                    <button
                        disabled={!newHeader.trim()}
                        onClick={() =>
                            void mutate([
                                {
                                    op: "add_columns",
                                    columns: [
                                        {
                                            id: `column_${Date.now()}`,
                                            header: newHeader,
                                            type: newType,
                                            description: question,
                                        },
                                    ],
                                },
                            ])
                        }
                    >
                        Add column
                    </button>
                    <button
                        onClick={() =>
                            void mutate([
                                {
                                    op: "add_rows",
                                    rows: [
                                        { id: `row_${Date.now()}`, cells: {} },
                                    ],
                                },
                            ])
                        }
                    >
                        Add empty row
                    </button>
                </fieldset>
            </div>
            {table && (
                <div className="flex-1 min-h-0">
                    <TableSnapshotView
                        surface={{
                            ...surface,
                            ref: undefined,
                            table,
                            title: undefined,
                        }}
                    />
                </div>
            )}
        </div>
    );
}
