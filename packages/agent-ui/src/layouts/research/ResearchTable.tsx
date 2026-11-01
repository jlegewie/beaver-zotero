import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toPlainText, type Column, type Row, type TableSpec } from "@beaver/agent-core/layouts/table";
import { cellsToFill } from "@beaver/agent-core/layouts/tableFill";
import {
    ArrowUpIcon,
    CalendarIcon,
    CancelIcon,
    CheckmarkCircleIcon,
    ChevronIcon,
    ClockIcon,
    CopyIcon,
    DeleteIcon,
    DownloadIcon,
    EditIcon,
    FileIcon,
    FilterIcon,
    Icon,
    LayersIcon,
    LibraryIcon,
    ListBulletIcon,
    MoreHorizontalIcon,
    PlayIcon,
    RepeatIcon,
    SearchIcon,
    TableIcon,
    TextIcon,
    ViewIcon,
} from "../../icons";
import MenuButton from "../../primitives/MenuButton";
import type { MenuItem } from "../../primitives/ContextMenu";
import { HoverLayerProvider } from "../../primitives/HoverLayer";
import { buildFilterMenu, buildSortMenu, FilterChips } from "../tableMenus";
import { renderPlainText, type TableDensity, type TextRenderer } from "../tableView";
import { useTableState } from "../useTableState";
import { CellEditor, editsAsList, type CellEditInput } from "./CellEditor";
import { CellInspector, type InspectorView } from "./CellInspector";
import { researchColumns, type TableDocuments } from "./cellModel";
import { paperOpenAction, rowItemReference } from "./PaperCell";
import { ResearchGrid, type CellAddress } from "./ResearchGrid";
import { AnchoredPopover, InlineText } from "./TableEditing";
import { getHost } from "../../host";

/** "3 new in 'Cash transfers'": a source whose items the table lacks. */
export interface NewPapersNotice {
    /** Papers the sources hold that the table does not. */
    count: number;
    /** The source's name, when one source has them. */
    sourceName?: string;
    /** How many sources have new papers. */
    sources: number;
}

/** The column types a user may change a question column to. */
export type ResearchColumnType = "text" | "boolean" | "select" | "date";

/** Named, ordered and drawn as the column editor and the create card show them. */
const COLUMN_TYPE_LABELS: Array<{ type: ResearchColumnType; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }> = [
    { type: "text", label: "Text", icon: TextIcon },
    { type: "date", label: "Date", icon: CalendarIcon },
    { type: "boolean", label: "Yes / no", icon: CheckmarkCircleIcon },
    { type: "select", label: "Category", icon: ListBulletIcon },
];

/**
 * The structural edit controls. Each is offered when its callback is
 * present; with `disabledReason` (a read-only library) they show disabled
 * with that reason.
 */
export interface ResearchTableEditing {
    disabledReason?: string;
    onTitle?(title: string): void;
    onDescription?(description: string): void;
    /** The column menu's Edit column…; also the (+) after the last column. */
    onEditColumn?(column: Column): void;
    onAddColumn?(): void;
    onChangeType?(column: Column, type: ResearchColumnType): void;
    onRemoveColumn?(column: Column): void;
    /** The sources popover's content, opened from the sources chip. */
    renderSources?(close: () => void): React.ReactNode;
    /** The new-papers notice's Add. */
    onAddNewPapers?(): void;
    /** Controls after the notice (+ Papers). */
    toolbarActions?: React.ReactNode;
}

/**
 * Editing cells (section 5's user cells): the editor on a cell, the
 * inspector's Edit, Clear and Restore Beaver's answer, and Choose document.
 * With `disabledReason` (a read-only library) the controls show disabled.
 */
export interface ResearchCellEditing {
    disabledReason?: string;
    /** Writes the user's answer; resolves to the refusal's message, if any. */
    onEdit(row: Row, column: Column, input: CellEditInput): Promise<string | null>;
    /** Gives the cell back to Beaver: its earlier answer, or empty and pending. */
    onRestore(row: Row, column: Column): void;
    /** Choose document… for a library item's row; also the inspector's Change. */
    onChooseDocument?(row: Row): void;
}

/**
 * The fill entry points beside the Fill button: Refill row, Fill this column
 * and the selection bar's "Fill N rows". Each opens the Fill popover's plan.
 */
export interface ResearchTableFill {
    /** Why no fill can start now (a read-only library, a fill running). */
    disabledReason?: string;
    onFillRows(rowIds: string[]): void;
    onFillColumn(column: Column): void;
}

/**
 * A cell to bring into view from outside the tab: a citation to a cell, say.
 * `token` changes with each request, so asking for the same cell again
 * focuses it again.
 */
export interface ResearchTableFocus {
    rowId: string;
    columnId?: string;
    token: number | string;
}

export interface ResearchTableProps {
    table: TableSpec;
    renderText?: TextRenderer;
    /** The table's documents as the host looked them up (names and kinds). */
    documents?: TableDocuments;
    /** The new-papers notice beside the sources chip; null for none. */
    newPapers?: NewPapersNotice | null;
    /**
     * Controls at the header's right, after More actions (the Fill button);
     * a function receives the selected rows' ids, in view order.
     */
    headerEnd?: React.ReactNode | ((selectedRowIds: string[]) => React.ReactNode);
    /** A warning about the whole table, kept above the grid. */
    notice?: React.ReactNode;
    /** News under the toolbar (a fill's result). */
    banner?: React.ReactNode;
    /** Show only these rows (a fill's failed rows). */
    onlyRows?: ReadonlySet<string> | null;
    /** More actions: each is offered when its callback is present. */
    onCopy?: (text: string) => void;
    onExport?: () => void;
    onShowInLibrary?: () => void;
    /** The version history view; offered under More actions when given. */
    renderVersionHistory?: () => React.ReactNode;
    /** Bulk verbs while rows are selected, after the count. */
    selectionActions?: (rowIds: string[], rows: Row[]) => React.ReactNode;
    /** More row actions, after Show in library. */
    rowMenuItems?: (row: Row) => MenuItem[];
    /** Cell editing; absent, cells are display only. */
    cellEditing?: ResearchCellEditing;
    /** Fill entry points in the row and column menus and the selection bar. */
    fill?: ResearchTableFill;
    /** Brings a row (and a cell, in the inspector) into view. */
    focus?: ResearchTableFocus | null;
    /** The structural edit controls; absent, the table is display only. */
    editing?: ResearchTableEditing;
    /** Window the rows, for a long table. */
    virtualize?: boolean;
    className?: string;
}

type Panel =
    | { kind: "cell"; address: CellAddress; view: InspectorView }
    | { kind: "history" };

const DENSITY_OPTIONS: Array<{ density: TableDensity; label: string; lines: number[] }> = [
    { density: "compact", label: "Compact rows", lines: [5, 9.5, 14, 18.5] },
    { density: "cozy", label: "Default rows", lines: [6, 12, 18] },
    { density: "tall", label: "Tall rows", lines: [8, 16] },
];

/**
 * The research table tab: identity and actions, the toolbar, the grid and the
 * cell inspector.
 *
 * It renders the spec and nothing else: what the host knows beyond it (the
 * documents' names, new papers in a source, the fill) arrives as props, and
 * every edit control is a slot the host fills when it can make the edit.
 */
export function ResearchTable({
    table,
    renderText = renderPlainText,
    documents,
    newPapers,
    headerEnd,
    notice,
    banner,
    onlyRows,
    onCopy,
    onExport,
    onShowInLibrary,
    renderVersionHistory,
    selectionActions,
    rowMenuItems,
    cellEditing,
    fill,
    focus,
    editing,
    virtualize,
    className,
}: ResearchTableProps): React.ReactElement {
    const state = useTableState(table, { density: "cozy", onlyRows });
    const columns = useMemo(() => researchColumns(table), [table]);
    const [panel, setPanel] = useState<Panel | null>(null);
    const [sourcesOpen, setSourcesOpen] = useState(false);
    const [editingCell, setEditingCell] = useState<CellAddress | null>(null);
    const editDisabled = editing?.disabledReason;
    const scrollRef = useRef<HTMLDivElement>(null);

    // The paper and the year are system columns, which the shared view state
    // hides by default; this table always shows them, so the sort and filter
    // menus offer them too.
    const shownKey = [columns.paper?.id, columns.year?.id].filter(Boolean).join(",");
    const showedSystem = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!shownKey || showedSystem.current === shownKey) return;
        showedSystem.current = shownKey;
        for (const id of shownKey.split(",")) if (state.hiddenColumns.has(id)) state.toggleColumn(id);
    }, [shownKey, state]);

    // The inspector follows its cell: closed when the row or column is gone.
    const selected = panel?.kind === "cell" ? panel.address : null;
    const selectedRow = selected ? table.rows.find((row) => row.id === selected.rowId) : undefined;
    const selectedColumn = selected
        ? columns.questions.find((column) => column.id === selected.columnId)
        : undefined;
    useEffect(() => {
        if (panel?.kind === "cell" && (!selectedRow || !selectedColumn)) setPanel(null);
    }, [panel, selectedRow, selectedColumn]);

    // The editor follows its cell the same way, and closes when editing ends.
    const editingRow = editingCell ? table.rows.find((row) => row.id === editingCell.rowId) : undefined;
    const editingColumn = editingCell ? columns.questions.find((column) => column.id === editingCell.columnId) : undefined;
    useEffect(() => {
        if (editingCell && (!editingRow || !editingColumn || !cellEditing || cellEditing.disabledReason)) setEditingCell(null);
    }, [editingCell, editingRow, editingColumn, cellEditing]);
    // The editor floats over its grid cell: a hidden column is shown and
    // filters hiding the row are cleared first (the inspector reaches both).
    const openEditor = useCallback(
        (address: CellAddress) => {
            if (state.hiddenColumns.has(address.columnId)) state.toggleColumn(address.columnId);
            if (!state.rows.some((row) => row.id === address.rowId)) state.clearFilters();
            setEditingCell(address);
        },
        [state],
    );
    // Scrolled to a frame after the editor opens, once the view with the row
    // in it (and a windowed grid's spacers) has rendered.
    const viewRows = useRef(state.rows);
    viewRows.current = state.rows;
    useEffect(() => {
        const scroller = scrollRef.current;
        const win = scroller?.ownerDocument.defaultView;
        if (!editingCell || !scroller || !win) return;
        const frame = win.requestAnimationFrame(() => {
            const index = viewRows.current.findIndex((row) => row.id === editingCell.rowId);
            scrollRowIntoView(scroller, editingCell.rowId, index >= 0 ? index : undefined);
        });
        return () => win.cancelAnimationFrame(frame);
        // Only when the editor opens on a cell, not on every view change.
    }, [editingCell]);
    // What Fill this column would fill, by column: its pending cells.
    const fillable = useMemo(() => {
        const counts = new Map<string, number>();
        if (!fill) return counts;
        for (const [, column] of cellsToFill(table)) counts.set(column, (counts.get(column) ?? 0) + 1);
        return counts;
    }, [fill != null, table]);

    const onSelectCell = useCallback(
        (address: CellAddress) =>
            setPanel((current) => ({
                kind: "cell",
                address,
                view: current?.kind === "cell" ? current.view : "cell",
            })),
        [],
    );

    const navigation = getHost().navigation;
    const rowMenu = useCallback(
        (row: Row): MenuItem[] => {
            const items: MenuItem[] = [];
            if (fill)
                items.push({
                    label: "Refill row",
                    icon: RepeatIcon,
                    disabled: !!fill.disabledReason,
                    onClick: () => fill.onFillRows([row.id]),
                });
            const ref = rowItemReference(row);
            if (ref && navigation)
                items.push({ label: "Show in library", icon: LibraryIcon, onClick: () => navigation.revealInLibrary(ref) });
            // The card's Open, reachable by keyboard.
            const open = paperOpenAction(row, documents);
            if (open) items.push({ label: open.label, icon: FileIcon, onClick: open.run });
            if (cellEditing?.onChooseDocument && row.ref?.kind === "item")
                items.push({
                    label: "Choose document…",
                    icon: FileIcon,
                    disabled: !!cellEditing.disabledReason,
                    onClick: () => cellEditing.onChooseDocument!(row),
                });
            return [...items, ...(rowMenuItems?.(row) ?? [])];
        },
        [navigation, rowMenuItems, documents, fill, cellEditing],
    );

    // A question column's menu: its edits (when the host makes them), then
    // the view's own Sort and Hide.
    const columnMenu = useCallback(
        (column: Column): MenuItem[] => {
            const items: MenuItem[] = [];
            const disabled = !!editing?.disabledReason;
            if (editing?.onEditColumn)
                items.push({ label: "Edit column…", icon: EditIcon, disabled, onClick: () => editing.onEditColumn!(column) });
            if (fill) {
                const cells = fillable.get(column.id) ?? 0;
                items.push({
                    label: cells ? `Fill this column (${cells.toLocaleString("en-US")})` : "Fill this column",
                    icon: PlayIcon,
                    disabled: !!fill.disabledReason,
                    onClick: () => fill.onFillColumn(column),
                });
            }
            if (items.length) items.push({ label: "", isDivider: true, onClick: () => {} });
            items.push({
                label: "Sort A → Z",
                icon: ArrowUpIcon,
                onClick: () => state.setSort({ column_id: column.id, direction: "asc" }),
            });
            items.push({ label: "Hide column", icon: ViewIcon, onClick: () => state.toggleColumn(column.id) });
            if (editing?.onChangeType) {
                const current = COLUMN_TYPE_LABELS.find((entry) => entry.type === column.type);
                items.push({
                    label: "Change type",
                    icon: current?.icon ?? TextIcon,
                    disabled,
                    onClick: () => {},
                    submenu: COLUMN_TYPE_LABELS.filter((entry) => entry.type !== column.type).map((entry) => ({
                        label: entry.label,
                        icon: entry.icon,
                        onClick: () => editing.onChangeType!(column, entry.type),
                    })),
                });
            }
            if (editing?.onRemoveColumn) {
                items.push({ label: "", isDivider: true, onClick: () => {} });
                items.push({
                    label: "Remove column",
                    disabled,
                    // Drawn like an item's own icon and label, in the danger colour.
                    customContent: (
                        <span className="display-flex items-center gap-2 w-full min-w-0 rt-menu-danger">
                            <Icon icon={DeleteIcon} size={14} className="flex-shrink-0" />
                            <span className="flex-1 text-base truncate">Remove column</span>
                        </span>
                    ),
                    onClick: () => editing.onRemoveColumn!(column),
                });
            }
            return items;
        },
        [editing, state, fill, fillable],
    );
    const hiddenQuestions = columns.questions.filter((column) => state.hiddenColumns.has(column.id));

    // Previous and next row in the view's order, keeping the column.
    const rowIndex = selected ? state.rows.findIndex((row) => row.id === selected.rowId) : -1;
    const stepRow = (delta: number) => {
        const next = state.rows[rowIndex + delta];
        if (!next || panel?.kind !== "cell") return;
        setPanel({ ...panel, address: { rowId: next.id, columnId: panel.address.columnId } });
        scrollRowIntoView(scrollRef.current, next.id, rowIndex + delta);
    };

    // A focus request from outside: clear what hides the row, scroll to it
    // and open its cell.
    const lastFocus = useRef<ResearchTableFocus["token"] | null>(null);
    useLayoutEffect(() => {
        if (!focus || focus.token === lastFocus.current) return;
        const row = table.rows.find((candidate) => candidate.id === focus.rowId);
        if (!row) return;
        lastFocus.current = focus.token;
        const viewIndex = state.rows.findIndex((candidate) => candidate.id === row.id);
        if (viewIndex < 0) state.clearFilters();
        if (focus.columnId && columns.questions.some((column) => column.id === focus.columnId))
            setPanel({ kind: "cell", address: { rowId: row.id, columnId: focus.columnId }, view: "cell" });
        scrollRowIntoView(scrollRef.current, row.id, viewIndex >= 0 ? viewIndex : table.rows.indexOf(row));
    }, [focus, table, state, columns.questions]);

    // The inspector's controls for the cell: Edit, and on the user's own
    // answer Clear and Restore Beaver's answer; Change beside the document.
    const cellActions = cellEditing
        ? (row: Row, column: Column): React.ReactNode => {
              const disabled = !!cellEditing.disabledReason;
              const title = cellEditing.disabledReason;
              const cell = row.cells[column.id];
              const mine = cell?.provenance === "user";
              return (
                  <>
                      <button
                          type="button"
                          className="rt-inspector-action"
                          disabled={disabled}
                          title={title}
                          onClick={() => openEditor({ rowId: row.id, columnId: column.id })}
                      >
                          Edit
                      </button>
                      {mine && cell.outcome !== "cleared" ? (
                          <button
                              type="button"
                              className="rt-inspector-action"
                              disabled={disabled}
                              title={title}
                              onClick={() => void cellEditing.onEdit(row, column, { op: "clear" })}
                          >
                              Clear
                          </button>
                      ) : null}
                      {mine ? (
                          <button
                              type="button"
                              className="rt-inspector-action"
                              disabled={disabled}
                              title={title ?? (cell.replaced ? undefined : "Beaver fills this cell again on the next Fill.")}
                              onClick={() => cellEditing.onRestore(row, column)}
                          >
                              {cell.replaced ? "Restore Beaver’s answer" : "Reset"}
                          </button>
                      ) : null}
                  </>
              );
          }
        : undefined;
    const documentAction = cellEditing?.onChooseDocument
        ? (row: Row): React.ReactNode =>
              row.ref?.kind === "item" ? (
                  <button
                      type="button"
                      className="rt-inspector-action rt-inspector-change"
                      disabled={!!cellEditing.disabledReason}
                      title={cellEditing.disabledReason ?? "Choose the document this row is read from"}
                      onClick={() => cellEditing.onChooseDocument!(row)}
                  >
                      Change
                  </button>
              ) : null
        : undefined;

    const moreItems: MenuItem[] = [];
    if (onCopy)
        moreItems.push({
            label: "Copy as text",
            icon: CopyIcon,
            onClick: () => {
                // The paper and the year are always columns here, though the
                // shared view state hides system columns by default.
                const visible = table.columns.filter(
                    (column) =>
                        column === columns.paper ||
                        column === columns.year ||
                        (columns.questions.includes(column) && !state.hiddenColumns.has(column.id)),
                );
                onCopy(toPlainText(table, state.rows, visible));
            },
        });
    if (onExport) moreItems.push({ label: "Export CSV", icon: DownloadIcon, onClick: onExport });
    if (onShowInLibrary) moreItems.push({ label: "Show in library", icon: LibraryIcon, onClick: onShowInLibrary });
    if (renderVersionHistory)
        moreItems.push({ label: "Version history", icon: ClockIcon, onClick: () => setPanel({ kind: "history" }) });

    const selectedIds = state.rows.filter((row) => state.selectedRows.has(row.id)).map((row) => row.id);
    const sourceCount = table.sources?.length ?? 0;
    const papers = table.rows.length;
    const sourcesLabel = `${sourceCount ? `${sourceCount} ${sourceCount === 1 ? "source" : "sources"} · ` : ""}${papers} ${papers === 1 ? "paper" : "papers"}`;
    const filterItems = buildFilterMenu(table, state);
    const sortItems = buildSortMenu(table, state);
    const sortColumn = state.sort ? table.columns.find((column) => column.id === state.sort!.column_id) : undefined;

    return (
        <HoverLayerProvider>
            <section className={`bt-surface rt-surface${className ? ` ${className}` : ""}`}>
                <header className="rt-header">
                    <span className="rt-header-icon" aria-hidden="true">
                        <Icon icon={TableIcon} size={18} />
                    </span>
                    <div className="rt-identity">
                        {editing?.onTitle ? (
                            <InlineText
                                as="h1"
                                className="rt-title"
                                value={table.title || ""}
                                placeholder="Table"
                                label="Rename table"
                                disabledReason={editDisabled}
                                onSave={editing.onTitle}
                            />
                        ) : (
                            <h1 className="rt-title">{table.title || "Table"}</h1>
                        )}
                        {editing?.onDescription ? (
                            <InlineText
                                className="rt-description"
                                value={table.description ?? ""}
                                placeholder="Add a description"
                                label="Edit description"
                                multiline
                                disabledReason={editDisabled}
                                onSave={editing.onDescription}
                            />
                        ) : table.description ? (
                            <p className="rt-description">{table.description}</p>
                        ) : null}
                    </div>
                    <div className="rt-header-actions">
                        {moreItems.length ? (
                            <MenuButton
                                menuItems={moreItems}
                                variant="surface"
                                icon={MoreHorizontalIcon}
                                className="rt-more"
                                ariaLabel="More actions"
                            />
                        ) : null}
                        {typeof headerEnd === "function" ? headerEnd(selectedIds) : headerEnd}
                    </div>
                </header>

                <div className="rt-toolbar">
                    {selectedIds.length > 0 ? (
                        <div className="rt-selectionbar">
                            <span className="rt-selection-count" role="status">
                                {selectedIds.length} selected
                            </span>
                            {fill ? (
                                <button
                                    type="button"
                                    className="rt-selection-action rt-selection-fill"
                                    disabled={!!fill.disabledReason}
                                    title={fill.disabledReason}
                                    onClick={() => fill.onFillRows(selectedIds)}
                                >
                                    {selectedIds.length === 1 ? "Fill 1 row" : `Fill ${selectedIds.length} rows`}
                                </button>
                            ) : null}
                            {selectionActions?.(
                                selectedIds,
                                state.rows.filter((row) => state.selectedRows.has(row.id)),
                            )}
                            <button
                                type="button"
                                className="rt-icon-button"
                                aria-label="Clear selection"
                                onClick={state.clearSelection}
                            >
                                <Icon icon={CancelIcon} size={12} />
                            </button>
                        </div>
                    ) : (
                        <div className="rt-toolbar-left">
                            {editing?.renderSources ? (
                                <AnchoredPopover
                                    open={sourcesOpen}
                                    label="Sources"
                                    className="rt-sources-popover"
                                    onClose={() => setSourcesOpen(false)}
                                    anchor={
                                        <button
                                            type="button"
                                            className="rt-sources-chip rt-sources-button"
                                            aria-haspopup="dialog"
                                            aria-expanded={sourcesOpen}
                                            onClick={() => setSourcesOpen((open) => !open)}
                                        >
                                            <Icon icon={LayersIcon} size={14} />
                                            {sourcesLabel}
                                            <Icon icon={ChevronIcon} size={11} className="rt-chip-chevron" />
                                        </button>
                                    }
                                >
                                    {editing.renderSources(() => setSourcesOpen(false))}
                                </AnchoredPopover>
                            ) : (
                                <span className="rt-sources-chip" title={sourceNames(table)}>
                                    <Icon icon={LayersIcon} size={14} />
                                    {sourcesLabel}
                                </span>
                            )}
                            {newPapers && newPapers.count > 0 ? (
                                <span className="rt-new-papers" role="status">
                                    <span className="rt-dot" aria-hidden="true" />
                                    {newPapers.sources === 1 && newPapers.sourceName
                                        ? `${newPapers.count} new in “${newPapers.sourceName}”`
                                        : `${newPapers.count} new in ${newPapers.sources} sources`}
                                    {editing?.onAddNewPapers ? (
                                        <button
                                            type="button"
                                            className="rt-new-papers-add"
                                            disabled={!!editDisabled}
                                            title={editDisabled ?? "Add them to the table"}
                                            onClick={editing.onAddNewPapers}
                                        >
                                            Add
                                        </button>
                                    ) : null}
                                </span>
                            ) : null}
                            {editing?.toolbarActions}
                        </div>
                    )}
                    <FilterChips table={table} state={state} />
                    {hiddenQuestions.length > 0 ? (
                        <button
                            type="button"
                            className="rt-hidden-columns"
                            title={hiddenQuestions.map((column) => column.header).join("\n")}
                            onClick={() => hiddenQuestions.forEach((column) => state.toggleColumn(column.id))}
                        >
                            {hiddenQuestions.length === 1
                                ? "1 hidden column · Show"
                                : `${hiddenQuestions.length} hidden columns · Show`}
                        </button>
                    ) : null}
                    <span className="rt-spacer" />
                    <label className="rt-search">
                        <Icon icon={SearchIcon} size={14} />
                        <input
                            type="text"
                            placeholder="Search rows"
                            aria-label="Search rows"
                            value={state.quickFilter}
                            onChange={(event) => state.setQuickFilter(event.target.value)}
                        />
                    </label>
                    {filterItems.length ? (
                        <MenuButton
                            menuItems={filterItems}
                            variant={state.filters.length ? "surface" : "ghost-secondary"}
                            icon={FilterIcon}
                            buttonLabel="Filter"
                            className="rt-toolbar-button"
                            ariaLabel="Filter rows"
                            maxHeight="24rem"
                            width="16rem"
                        />
                    ) : null}
                    {sortItems.length ? (
                        <MenuButton
                            menuItems={sortItems}
                            variant={sortColumn ? "surface" : "ghost-secondary"}
                            icon={ChevronIcon}
                            buttonLabel={
                                sortColumn
                                    ? `Sort: ${sortColumn.header} ${state.sort!.direction === "asc" ? "↑" : "↓"}`
                                    : "Sort"
                            }
                            className="rt-toolbar-button"
                            ariaLabel="Sort rows"
                            maxHeight="24rem"
                            width="16rem"
                        />
                    ) : null}
                    <div className="rt-density" role="group" aria-label="Row height">
                        {DENSITY_OPTIONS.map((option) => (
                            <button
                                key={option.density}
                                type="button"
                                aria-label={option.label}
                                title={option.label}
                                aria-pressed={state.density === option.density}
                                className={state.density === option.density ? "rt-active" : ""}
                                onClick={() => state.setDensity(option.density)}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                                    <path d={option.lines.map((y) => `M4 ${y}h16`).join("")} />
                                </svg>
                            </button>
                        ))}
                    </div>
                </div>

                {notice ? (
                    <div className="bt-notice" role="status">
                        {notice}
                    </div>
                ) : null}
                {banner ? (
                    <div className="bt-banner" role="status">
                        {banner}
                    </div>
                ) : null}

                <div className="rt-body">
                    <div ref={scrollRef} className="bt-scroll rt-scroll">
                        <ResearchGrid
                            table={table}
                            state={state}
                            columns={columns}
                            renderText={renderText}
                            documents={documents}
                            selected={selected}
                            onSelectCell={onSelectCell}
                            rowMenuItems={rowMenu}
                            columnMenuItems={columnMenu}
                            onAddColumn={editing?.onAddColumn}
                            editDisabledReason={editDisabled}
                            onEditCell={cellEditing ? openEditor : undefined}
                            cellEditDisabledReason={cellEditing?.disabledReason}
                            cellEditor={
                                editingCell && editingRow && editingColumn && cellEditing
                                    ? {
                                          address: editingCell,
                                          list: editsAsList(editingColumn),
                                          content: (
                                              <CellEditor
                                                  key={`${editingCell.rowId}/${editingCell.columnId}`}
                                                  column={editingColumn}
                                                  cell={editingRow.cells[editingColumn.id]}
                                                  onCancel={() => setEditingCell(null)}
                                                  onSave={async (input) => {
                                                      const refused = await cellEditing.onEdit(editingRow, editingColumn, input);
                                                      if (!refused) setEditingCell(null);
                                                      return refused;
                                                  }}
                                              />
                                          ),
                                      }
                                    : null
                            }
                            virtualize={virtualize}
                            emptyText="No papers yet"
                            filteredEmptyText="No rows match the search or filters"
                        />
                    </div>
                    {panel?.kind === "cell" && selectedRow && selectedColumn ? (
                        <CellInspector
                            row={selectedRow}
                            paperColumnId={columns.paper?.id}
                            column={selectedColumn}
                            questions={columns.questions}
                            view={panel.view}
                            onView={(view) => setPanel({ ...panel, view })}
                            onColumn={(columnId) =>
                                setPanel({ kind: "cell", address: { rowId: selectedRow.id, columnId }, view: "cell" })
                            }
                            onPrevious={rowIndex > 0 ? () => stepRow(-1) : undefined}
                            onNext={rowIndex >= 0 && rowIndex < state.rows.length - 1 ? () => stepRow(1) : undefined}
                            onClose={() => setPanel(null)}
                            renderText={renderText}
                            documents={documents}
                            cellActions={cellActions}
                            documentAction={documentAction}
                        />
                    ) : panel?.kind === "history" && renderVersionHistory ? (
                        <aside className="rt-inspector rt-history" aria-label="Version history">
                            <div className="rt-inspector-head">
                                <div className="rt-inspector-nav">
                                    <span className="rt-inspector-paper rt-panel-title">Version history</span>
                                    <button
                                        type="button"
                                        className="rt-icon-button"
                                        aria-label="Close version history"
                                        onClick={() => setPanel(null)}
                                    >
                                        <Icon icon={CancelIcon} size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className="rt-inspector-body">{renderVersionHistory()}</div>
                        </aside>
                    ) : null}
                </div>
            </section>
        </HoverLayerProvider>
    );
}

/** The sources' names, for the chip's tooltip. */
function sourceNames(table: TableSpec): string | undefined {
    const names = (table.sources ?? []).map((source) =>
        source.type === "items"
            ? `Added papers · ${source.ids?.length ?? 0}`
            : (source.scope?.name ?? source.scope?.tag ?? source.type),
    );
    return names.length ? names.join("\n") : undefined;
}

/**
 * Scrolls a row into the grid's viewport. A windowed grid may not have the
 * row in the DOM yet: the scroll first goes to its estimated position, and a
 * frame later to the row itself.
 */
function scrollRowIntoView(scroller: HTMLElement | null, rowId: string, index?: number): void {
    if (!scroller) return;
    const find = () =>
        scroller.querySelector<HTMLElement>(`tr[data-row-id="${rowId.replace(/["\\]/g, "\\$&")}"]`);
    const row = find();
    if (row) {
        row.scrollIntoView?.({ block: "nearest" });
        return;
    }
    if (index != null) {
        const sample = scroller.querySelector<HTMLElement>("tr.rt-row");
        scroller.scrollTop = index * (sample?.offsetHeight ?? 80);
    }
    scroller.ownerDocument.defaultView?.requestAnimationFrame(() => find()?.scrollIntoView?.({ block: "nearest" }));
}
