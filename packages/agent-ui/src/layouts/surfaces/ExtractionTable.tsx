import React, { useState } from "react";
import {
    anchorColumn,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import {
    AiMagicIcon,
    DownloadIcon,
    EditIcon,
    PlusSignIcon,
    RepeatIcon,
    DeleteIcon,
} from "../../icons";
import Button from "../../primitives/Button";
import type { MenuItem } from "../../primitives/ContextMenu";
import { AddColumnDialog, type ColumnDraft } from "../chrome/AddColumnDialog";
import {
    csvForCurrentView,
    TableSurface,
    type TableSurfaceProps,
} from "../chrome/TableSurface";
import { useTableState } from "../useTableState";
import type { TextRenderer } from "../tableView";

export interface ExtractionTableProps {
    table: TableSpec;
    subtitle?: React.ReactNode;

    /**
     * Runs a new column over the table. Absent ⇒ no add-column control, even
     * where the spec allows one: the affordance belongs to a surface that can
     * actually run it.
     */
    onAddColumn?: (draft: ColumnDraft) => void;
    /** Re-runs one column over every row. */
    onRerunColumn?: (column: Column) => void;
    /** Opens the column's question for editing; the dialog is reused for it. */
    onEditColumn?: (column: Column, draft: ColumnDraft) => void;
    onRemoveColumn?: (column: Column) => void;
    /** Re-runs a single cell — offered beside a cell that failed. */
    onRetryCell?: (row: Row, column: Column) => void;

    onExport?: (csv: string, table: TableSpec) => void;
    /** Reveals the table's own library item. Absent ⇒ no control. */
    onShowInLibrary?: (table: TableSpec) => void;
    /** Adds more items to extract from. */
    onAddRows?: () => void;

    renderText?: TextRenderer;
    density?: TableSurfaceProps["density"];
    /** Narrow surface: carry the primary columns only. */
    primaryColumnsOnly?: boolean;
    className?: string;
}

type Composer = { mode: "add" } | { mode: "edit"; column: Column } | undefined;

/**
 * A table the user builds: one row per item, one column per extracted field.
 *
 * The difference from a search-results table is entirely in the chrome — the
 * grid is the same component — because a column here is a question the user
 * can add, re-run or reword, and every one of those is a billed run. So the
 * composer states the cost before it starts, and each column header carries its
 * own menu.
 *
 * `capabilities.allow_add_column` and a callback both have to be present for
 * the control to appear: the spec says whether this table may grow, the
 * callback says whether this surface can make it.
 */
export function ExtractionTable({
    table,
    subtitle,
    onAddColumn,
    onRerunColumn,
    onEditColumn,
    onRemoveColumn,
    onRetryCell,
    onExport,
    onShowInLibrary,
    onAddRows,
    renderText,
    density,
    primaryColumnsOnly,
    className,
}: ExtractionTableProps): React.ReactElement {
    const state = useTableState(table, { density: density ?? "tall" });
    const [composer, setComposer] = useState<Composer>(undefined);

    const canAddColumn =
        !!onAddColumn && (table.capabilities?.allow_add_column ?? false);
    const canAddRows =
        !!onAddRows && (table.capabilities?.allow_add_row ?? false);

    // The anchor carries row identity and has no extraction question, so none
    // of these verbs mean anything on it — and "Remove column" would strip the
    // table of what identifies its rows.
    const anchorId = anchorColumn(table)?.id;

    const columnMenuItems = (column: Column): MenuItem[] => {
        if (column.id === anchorId) return [];
        const items: MenuItem[] = [];
        if (onEditColumn)
            items.push({
                label: "Edit question",
                icon: EditIcon,
                onClick: () => setComposer({ mode: "edit", column }),
            });
        if (onRerunColumn)
            items.push({
                label: "Re-run column",
                icon: RepeatIcon,
                onClick: () => onRerunColumn(column),
            });
        if (onRemoveColumn)
            items.push({
                label: "Remove column",
                icon: DeleteIcon,
                onClick: () => onRemoveColumn(column),
            });
        return items;
    };

    const submitComposer = (draft: ColumnDraft) => {
        if (composer?.mode === "edit") onEditColumn?.(composer.column, draft);
        else onAddColumn?.(draft);
        setComposer(undefined);
    };

    return (
        <TableSurface
            table={table}
            state={state}
            icon={AiMagicIcon}
            subtitle={subtitle}
            rowNoun="item"
            renderText={renderText}
            primaryColumnsOnly={primaryColumnsOnly}
            className={className}
            emptyText="Nothing extracted yet"
            columnMenuItems={columnMenuItems}
            onRetryCell={onRetryCell}
            headerActions={
                <>
                    {onExport ? (
                        <Button
                            variant="surface"
                            icon={DownloadIcon}
                            onClick={() =>
                                onExport(csvForCurrentView(table, state), table)
                            }
                        >
                            Export
                        </Button>
                    ) : null}
                    {onShowInLibrary ? (
                        <Button
                            variant="solid"
                            onClick={() => onShowInLibrary(table)}
                        >
                            Show in library
                        </Button>
                    ) : null}
                </>
            }
            toolbarActions={
                <>
                    {canAddRows ? (
                        <Button
                            variant="surface"
                            icon={PlusSignIcon}
                            onClick={onAddRows}
                        >
                            Add items
                        </Button>
                    ) : null}
                    {canAddColumn ? (
                        <Button
                            variant="solid"
                            icon={PlusSignIcon}
                            onClick={() => setComposer({ mode: "add" })}
                        >
                            Add column
                        </Button>
                    ) : null}
                </>
            }
            overlay={
                composer ? (
                    <div className="bt-overlay">
                        <AddColumnDialog
                            // The composer reads its prefill once, so switching
                            // to another column must remount it — otherwise the
                            // previous column's question is submitted against
                            // this one, and that starts a billed run.
                            key={
                                composer.mode === "edit"
                                    ? `edit:${composer.column.id}`
                                    : "add"
                            }
                            rowCount={table.rows.length}
                            costEstimate={table.cost_estimate}
                            initial={
                                composer.mode === "edit"
                                    ? {
                                          header: composer.column.header,
                                          type: composer.column.type,
                                          description:
                                              composer.column.description,
                                      }
                                    : undefined
                            }
                            title={
                                composer.mode === "edit"
                                    ? "Edit column"
                                    : "New column"
                            }
                            submitLabel={
                                composer.mode === "edit"
                                    ? "Re-run column"
                                    : "Extract column"
                            }
                            onSubmit={submitComposer}
                            onCancel={() => setComposer(undefined)}
                        />
                    </div>
                ) : null
            }
        />
    );
}

export default ExtractionTable;
