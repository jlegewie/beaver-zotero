import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isColumnSortable, toPlainText, type Column, type Row, type TableSpec } from "@beaver/agent-core/layouts/table";
import { cellsToFill } from "@beaver/agent-core/layouts/tableFill";
import type { TableFillCells } from "@beaver/agent-core/protocol/tableFillProtocol";
import {
    ArrowDownIcon,
    ArrowUpIcon,
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
import ContextMenu, { type MenuItem, type MenuPosition } from "../../primitives/ContextMenu";
import { HoverLayerProvider, selectionWithin } from "../../primitives/HoverLayer";
import { buildFilterMenu, buildSortMenu, FilterChips } from "../tableMenus";
import { renderPlainText, type TableDensity, type TextRenderer } from "../tableView";
import { useTableState } from "../useTableState";
import { CellEditor, editsAsList, type CellEditInput } from "./CellEditor";
import { CellInspector, type CellActionControls } from "./CellInspector";
import { cellFill, isNewRow, PAPER_HEADER, researchColumns, rowFills, sortOrderLabel, type TableDocuments } from "./cellModel";
import { ResearchGrid, type CellAddress } from "./ResearchGrid";
import { AnchoredPopover, InlineText } from "./TableEditing";

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
export type ResearchColumnType = "text" | "boolean" | "select";

/** Named, ordered and drawn as the column editor and the create card show them. */
const COLUMN_TYPE_LABELS: Array<{ type: ResearchColumnType; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }> = [
    { type: "text", label: "Text", icon: TextIcon },
    { type: "boolean", label: "Yes / no", icon: CheckmarkCircleIcon },
    { type: "select", label: "Category", icon: ListBulletIcon },
];

/**
 * The structural edit controls. Each is offered when its callback is
 * present; with `disabledReason` (a read-only library, a running fill) they
 * show disabled with that reason.
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
    /** Controls after the notice (+ Items). */
    toolbarActions?: React.ReactNode;
}

/**
 * Editing cells (section 5's user cells): the editor on a cell, the
 * inspector's Edit and Reset to Beaver's answer, and Choose document.
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

/**
 * Rows the user just added, to bring into view once the table has them.
 * `token` changes with each request.
 */
export interface ResearchTableReveal {
    rowIds: readonly string[];
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
    /** News above the grid, beside the side panel (a fill's result). */
    banner?: React.ReactNode;
    /**
     * The user acted on the table: selected a cell, opened the cell editor,
     * or changed the sort, filters or search.
     */
    onActivity?: () => void;
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
    /** The cells a running fill will still write; they show as filling until their answers land. */
    filling?: readonly TableFillCells[];
    /** Brings a row (and a cell, in the inspector) into view. */
    focus?: ResearchTableFocus | null;
    /**
     * Rows the user just added: scrolled to and briefly highlighted. Rows the
     * search or a filter hides are offered behind a Show button instead.
     */
    reveal?: ResearchTableReveal | null;
    /** The structural edit controls; absent, the table is display only. */
    editing?: ResearchTableEditing;
    /** Window the rows, for a long table. */
    virtualize?: boolean;
    className?: string;
}

const NO_ROWS: ReadonlySet<string> = new Set();

/** How long rows the user just added stay highlighted. */
const ADDED_HIGHLIGHT_MS = 2000;

/** The side panel: a selected cell (a question, or the Paper cell) or the version history. */
type Panel = { kind: "cell"; address: CellAddress } | { kind: "history" };

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
    onActivity,
    onlyRows,
    onCopy,
    onExport,
    onShowInLibrary,
    renderVersionHistory,
    selectionActions,
    rowMenuItems,
    cellEditing,
    fill,
    filling,
    focus,
    reveal,
    editing,
    virtualize,
    className,
}: ResearchTableProps): React.ReactElement {
    const columns = useMemo(() => researchColumns(table), [table]);
    // The paper and the year are system columns, which the shared view state
    // hides by default; this table always draws them.
    const alwaysShown = useMemo(
        () => [columns.paper?.id, columns.year?.id].filter((id): id is string => !!id),
        [columns],
    );
    const state = useTableState(table, { density: "cozy", onlyRows, alwaysShown });
    // The toolbar's menus and chips name the paper column as its header does.
    const menuTable = useMemo(
        () =>
            columns.paper
                ? {
                      ...table,
                      columns: table.columns.map((column) =>
                          column === columns.paper ? { ...column, header: PAPER_HEADER } : column,
                      ),
                  }
                : table,
        [table, columns.paper],
    );
    const [panel, setPanel] = useState<Panel | null>(null);
    const [sourcesOpen, setSourcesOpen] = useState(false);
    const [editingCell, setEditingCell] = useState<CellAddress | null>(null);
    const editDisabled = editing?.disabledReason;
    const scrollRef = useRef<HTMLDivElement>(null);
    // Holds the surface and its hover layers, which the provider draws beside it.
    const copyScopeRef = useRef<HTMLDivElement>(null);
    const selectionCopy = useSelectionCopy(copyScopeRef, onCopy);
    const activityRef = useRef(onActivity);
    activityRef.current = onActivity;
    // Rows just added: those highlighted now, and those the view hides.
    const [addedRows, setAddedRows] = useState<ReadonlySet<string>>(NO_ROWS);
    const [hiddenAdded, setHiddenAdded] = useState<ReadonlySet<string>>(NO_ROWS);

    // A change of sort, filters or search is the user's: the first render
    // only sets them up, and a focus request's reveal forgets the last view.
    const viewKey = useRef<unknown[] | null>(null);
    useEffect(() => {
        const next = [state.sort, state.filters, state.quickFilter];
        const previous = viewKey.current;
        viewKey.current = next;
        if (previous && next.some((value, index) => value !== previous[index])) {
            activityRef.current?.();
            setHiddenAdded(NO_ROWS);
        }
    }, [state.sort, state.filters, state.quickFilter]);

    // The inspector follows its cell: closed when the row or column is gone.
    // The Paper cell opens the row's paper view.
    const selected = panel?.kind === "cell" ? panel.address : null;
    const selectedRow = selected ? table.rows.find((row) => row.id === selected.rowId) : undefined;
    const selectedColumn = selected
        ? columns.questions.find((column) => column.id === selected.columnId)
        : undefined;
    const selectedPaper = !!selected && !!columns.paper && selected.columnId === columns.paper.id;
    useEffect(() => {
        if (panel?.kind === "cell" && (!selectedRow || (!selectedColumn && !selectedPaper))) setPanel(null);
    }, [panel, selectedRow, selectedColumn, selectedPaper]);
    // The rail and Paper column are pinned only while the grid leaves at least
    // as much room beside them for answers; a narrow grid (a small window, the
    // inspector open) scrolls them away like any other column.
    const [pinned, setPinned] = useState(false);
    useLayoutEffect(() => {
        const scroller = scrollRef.current;
        const Observer = scroller?.ownerDocument.defaultView?.ResizeObserver;
        if (!scroller || !Observer) return;
        const update = () => {
            const width = ["rt-th-rail", "rt-th-paper"].reduce(
                (sum, name) => sum + (scroller.querySelector<HTMLElement>(`.${name}`)?.offsetWidth ?? 0),
                0,
            );
            setPinned(width > 0 && scroller.clientWidth >= 2 * width);
        };
        const observer = new Observer(update);
        observer.observe(scroller);
        update();
        return () => observer.disconnect();
    }, []);
    // The inspector narrows the grid: keep its cell in view beside it, and
    // clear of the pinned Paper column.
    useEffect(() => {
        const scroller = scrollRef.current;
        if (!selected || !scroller) return;
        const esc = (value: string) => value.replace(/["\\]/g, "\\$&");
        const cell = scroller.querySelector<HTMLElement>(
            `tr[data-row-id="${esc(selected.rowId)}"] td[data-column-id="${esc(selected.columnId)}"]`,
        );
        cell?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        const paper = pinned ? cell?.parentElement?.querySelector<HTMLElement>(".rt-td-paper") : null;
        if (!cell || !paper || paper === cell) return;
        const covered = paper.getBoundingClientRect().right - cell.getBoundingClientRect().left;
        if (covered > 0) scroller.scrollLeft -= covered;
    }, [selected?.rowId, selected?.columnId]);

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
            activityRef.current?.();
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

    const fills = useMemo(() => rowFills(filling), [filling]);

    const onSelectCell = useCallback((address: CellAddress) => {
        setPanel({ kind: "cell", address });
        activityRef.current?.();
    }, []);

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
            if (cellEditing?.onChooseDocument && row.ref?.kind === "item")
                items.push({
                    label: "Choose document…",
                    icon: FileIcon,
                    disabled: !!cellEditing.disabledReason,
                    onClick: () => cellEditing.onChooseDocument!(row),
                });
            return [...items, ...(rowMenuItems?.(row) ?? [])];
        },
        [rowMenuItems, fill, cellEditing],
    );

    // A column menu's sort entries: both directions, and Clear sort on the
    // column the view is sorted by.
    const sortEntries = useCallback(
        (column: Column): MenuItem[] => {
            if (!isColumnSortable(column)) return [];
            const year = column === columns.year;
            const items: MenuItem[] = [
                {
                    label: `Sort ${sortOrderLabel("asc", year)}`,
                    icon: ArrowUpIcon,
                    onClick: () => state.setSort({ column_id: column.id, direction: "asc" }),
                },
                {
                    label: `Sort ${sortOrderLabel("desc", year)}`,
                    icon: ArrowDownIcon,
                    onClick: () => state.setSort({ column_id: column.id, direction: "desc" }),
                },
            ];
            if (state.sort?.column_id === column.id)
                items.push({ label: "Clear sort", icon: CancelIcon, onClick: () => state.setSort(undefined) });
            return items;
        },
        [state, columns.year],
    );

    // A column's menu. The paper's and the year's offer only the sort; a
    // question's has its edits (when the host makes them), then the view's
    // own Sort and Hide.
    const columnMenu = useCallback(
        (column: Column): MenuItem[] => {
            if (column === columns.paper || column === columns.year) return sortEntries(column);
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
            items.push(...sortEntries(column));
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
        [editing, state, fill, fillable, columns, sortEntries],
    );
    const hiddenQuestions = columns.questions.filter((column) => state.hiddenColumns.has(column.id));

    // Previous and next row in the view's order, keeping the column (or the
    // paper view).
    const rowIndex = selected ? state.rows.findIndex((row) => row.id === selected.rowId) : -1;
    const stepRow = (delta: number) => {
        const next = state.rows[rowIndex + delta];
        if (!next || panel?.kind !== "cell") return;
        setPanel({ kind: "cell", address: { rowId: next.id, columnId: panel.address.columnId } });
        scrollRowIntoView(scrollRef.current, next.id, rowIndex + delta);
    };

    // A focus request from outside: show what hides the row or the cell (a
    // filter, a hidden column), then, once that view has rendered, scroll to
    // the row and open its cell.
    const lastFocus = useRef<ResearchTableFocus["token"] | null>(null);
    const revealedFor = useRef<ResearchTableFocus["token"] | null>(null);
    useLayoutEffect(() => {
        if (!focus || focus.token === lastFocus.current) return;
        // A row or column not rendered yet (a reused tab still reading the
        // table) waits for the table that has it.
        const row = table.rows.find((candidate) => candidate.id === focus.rowId);
        if (!row || (focus.columnId && !table.columns.some((column) => column.id === focus.columnId))) return;
        const columnId = columns.questions.some((column) => column.id === focus.columnId) ? focus.columnId : undefined;
        const viewIndex = state.rows.findIndex((candidate) => candidate.id === row.id);
        const hidden = columnId !== undefined && state.hiddenColumns.has(columnId);
        if ((viewIndex < 0 || hidden) && revealedFor.current !== focus.token) {
            revealedFor.current = focus.token;
            if (viewIndex < 0) {
                viewKey.current = null;
                state.clearFilters();
            }
            if (hidden) state.toggleColumn(columnId);
            return;
        }
        lastFocus.current = focus.token;
        // A row cited alone closes a cell inspector, which would show another cell.
        if (columnId) setPanel({ kind: "cell", address: { rowId: row.id, columnId } });
        else setPanel((current) => (current?.kind === "cell" ? null : current));
        scrollRowIntoView(scrollRef.current, row.id, viewIndex >= 0 ? viewIndex : undefined);
    }, [focus, table, state, columns.questions]);

    // Rows the user just added: once the table has them, scroll to the first
    // in the view's order and highlight those shown. Rows the search or a
    // filter hides wait behind Show rather than undoing the user's view.
    const showRows = (ids: ReadonlySet<string>) => {
        const shown = state.rows.filter((row) => ids.has(row.id));
        const shownIds = new Set(shown.map((row) => row.id));
        if (shown.length) {
            setAddedRows(shownIds);
            scrollRowIntoView(scrollRef.current, shown[0].id, state.rows.indexOf(shown[0]), "center");
        }
        setHiddenAdded(new Set(table.rows.filter((row) => ids.has(row.id) && !shownIds.has(row.id)).map((row) => row.id)));
    };
    const lastReveal = useRef<ResearchTableReveal["token"] | null>(null);
    useLayoutEffect(() => {
        if (!reveal || reveal.token === lastReveal.current) return;
        const ids = new Set(reveal.rowIds);
        // The edit's result can arrive before the re-read that has its rows.
        if (!table.rows.some((row) => ids.has(row.id))) return;
        lastReveal.current = reveal.token;
        showRows(ids);
    }, [reveal, table, state.rows]);
    // Show: clears the search and filters, then reveals the rows in that view.
    const [showingAdded, setShowingAdded] = useState(false);
    useLayoutEffect(() => {
        if (!showingAdded) return;
        setShowingAdded(false);
        showRows(hiddenAdded);
    }, [showingAdded]);
    useEffect(() => {
        if (!addedRows.size) return;
        const timer = setTimeout(() => setAddedRows(NO_ROWS), ADDED_HIGHLIGHT_MS);
        return () => clearTimeout(timer);
    }, [addedRows]);

    // The inspector's controls for the cell: the Edit pencil beside the
    // answer, and on the user's own answer Reset to Beaver's answer under it;
    // Change beside the document.
    const cellActions = cellEditing
        ? (row: Row, column: Column): CellActionControls => {
              const disabled = !!cellEditing.disabledReason;
              const title = cellEditing.disabledReason;
              const cell = row.cells[column.id];
              const mine = cell?.provenance === "user";
              return {
                  edit: (
                      <button
                          type="button"
                          className="rt-icon-button rt-inspector-edit"
                          aria-label="Edit answer"
                          disabled={disabled}
                          title={title ?? "Edit answer"}
                          onClick={() => openEditor({ rowId: row.id, columnId: column.id })}
                      >
                          <Icon icon={EditIcon} size={13} />
                      </button>
                  ),
                  more: mine ? (
                      <button
                          type="button"
                          className="rt-inspector-link"
                          disabled={disabled}
                          title={title ?? (cell.replaced ? undefined : "Beaver fills this cell again on the next Fill.")}
                          onClick={() => cellEditing.onRestore(row, column)}
                      >
                          {cell.replaced ? "Reset to Beaver’s answer" : "Reset"}
                      </button>
                  ) : undefined,
              };
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
    const items = table.rows.length;
    const sourcesLabel = `${sourceCount ? `${sourceCount} ${sourceCount === 1 ? "source" : "sources"} · ` : ""}${items} ${items === 1 ? "item" : "items"}`;
    const filterItems = buildFilterMenu(menuTable, state);
    const sortItems = buildSortMenu(menuTable, state);
    const sortColumn = state.sort ? menuTable.columns.find((column) => column.id === state.sort!.column_id) : undefined;

    return (
        <div ref={copyScopeRef} className="rt-copy-scope" onContextMenu={selectionCopy.onContextMenu}>
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
                        <FilterChips table={menuTable} state={state} />
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
                        {hiddenAdded.size > 0 ? (
                            <button
                                type="button"
                                className="rt-hidden-columns rt-hidden-added"
                                title="The search or filters hide them"
                                onClick={() => {
                                    state.clearFilters();
                                    setShowingAdded(true);
                                }}
                            >
                                {hiddenAdded.size === 1
                                    ? "1 added item hidden · Show"
                                    : `${hiddenAdded.size} added items hidden · Show`}
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

                    <div className="rt-body">
                        {/* The grid's column: the notice and the banner span the
                            grid only, so the side panel starts under the toolbar. */}
                        <div className="rt-main">
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
                            <div ref={scrollRef} className="bt-scroll rt-scroll" data-pinned={pinned || undefined}>
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
                                    onCopyCell={onCopy}
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
                                    fills={fills}
                                    addedRows={addedRows}
                                    virtualize={virtualize}
                                    emptyText="No items yet"
                                    filteredEmptyText="No rows match the search or filters"
                                />
                            </div>
                        </div>
                        {panel?.kind === "cell" && selectedRow && (selectedColumn || selectedPaper) ? (
                            <CellInspector
                                row={selectedRow}
                                paperColumnId={columns.paper?.id}
                                column={selectedColumn}
                                fill={selectedColumn ? cellFill(fills.get(selectedRow.id), selectedColumn.id) : undefined}
                                questions={columns.questions}
                                table={table}
                                rowMenuItems={rowMenu(selectedRow)}
                                isNew={isNewRow(table, selectedRow)}
                                onColumn={(columnId) => setPanel({ kind: "cell", address: { rowId: selectedRow.id, columnId } })}
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
            {selectionCopy.menu}
        </div>
    );
}

/** Whether a key event's target edits text (an input, a textarea, an editable element). */
function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || el.nodeType !== 1) return false;
    return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

/** The text selected within `scope`, or "" when nothing is. */
function selectedTextWithin(scope: HTMLElement | null): string {
    return selectionWithin(scope) ? (scope!.ownerDocument.defaultView?.getSelection()?.toString() ?? "") : "";
}

/**
 * Copies the text selected in the table (its cells, their expansions and the
 * inspector) through the host: Cmd / Ctrl+C, or Copy in the menu a right-click
 * on a selection opens. A chrome document does not copy a page selection on
 * its own. Without `onCopy` the surface leaves copying to its document.
 */
function useSelectionCopy(
    scopeRef: React.RefObject<HTMLElement>,
    onCopy: ((text: string) => void) | undefined,
): { onContextMenu?: (event: React.MouseEvent) => void; menu: React.ReactNode } {
    const [menu, setMenu] = useState<{ position: MenuPosition; text: string } | null>(null);
    const copyRef = useRef(onCopy);
    copyRef.current = onCopy;
    const copies = !!onCopy;
    useEffect(() => {
        const scope = scopeRef.current;
        if (!copies || !scope) return;
        const doc = scope.ownerDocument;
        const onKey = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
            if (event.key.toLowerCase() !== "c" || event.isComposing || isEditableTarget(event.target)) return;
            const text = selectedTextWithin(scope);
            if (text.trim()) copyRef.current?.(text);
        };
        doc.addEventListener("keydown", onKey);
        return () => doc.removeEventListener("keydown", onKey);
    }, [scopeRef, copies]);
    if (!onCopy) return { menu: null };
    return {
        onContextMenu: (event) => {
            if (isEditableTarget(event.target)) return;
            const text = selectedTextWithin(scopeRef.current);
            if (!text.trim()) return;
            event.preventDefault();
            setMenu({ position: { x: event.clientX, y: event.clientY }, text });
        },
        menu: menu ? (
            <ContextMenu
                menuItems={[{ label: "Copy", icon: CopyIcon, onClick: () => onCopy(menu.text) }]}
                isOpen
                onClose={() => setMenu(null)}
                position={menu.position}
                useFixedPosition
                className="rt-copy-menu"
            />
        ) : null,
    };
}

/** The sources' names, for the chip's tooltip. */
function sourceNames(table: TableSpec): string | undefined {
    const names = (table.sources ?? []).map((source) =>
        source.type === "items"
            ? `Added items · ${source.ids?.length ?? 0}`
            : (source.scope?.name ?? source.scope?.tag ?? source.type),
    );
    return names.length ? names.join("\n") : undefined;
}

/**
 * Scrolls a row into the grid's viewport. A windowed grid may not have the
 * row in the DOM yet: the scroll first goes to its estimated position, and a
 * frame later to the row itself.
 */
function scrollRowIntoView(
    scroller: HTMLElement | null,
    rowId: string,
    index?: number,
    block: ScrollLogicalPosition = "nearest",
): void {
    if (!scroller) return;
    const find = () =>
        scroller.querySelector<HTMLElement>(`tr[data-row-id="${rowId.replace(/["\\]/g, "\\$&")}"]`);
    const row = find();
    if (row) {
        row.scrollIntoView?.({ block });
        return;
    }
    if (index != null) {
        const sample = scroller.querySelector<HTMLElement>("tr.rt-row");
        scroller.scrollTop = index * (sample?.offsetHeight ?? 80);
    }
    scroller.ownerDocument.defaultView?.requestAnimationFrame(() => find()?.scrollIntoView?.({ block }));
}
