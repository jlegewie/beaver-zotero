// The shared layout renderers. Like the other barrels, this is the root the
// closure check starts from; consumers import a component by its own subpath
// (`@beaver/agent-ui/layouts/DataTable`).
//
// Three layers, and the split is the point:
//
//   grid     — `DataTable` and the cell / header / action pieces it is made of.
//              Renders a `TableSpec` and nothing else, so a table embedded in a
//              chat message can use it on its own.
//   chrome   — `TableSurface` and the bars it composes. Title, toolbar, footer,
//              dialogs: everything a window puts *around* a table, none of which
//              belongs in `TableSpec`.
//   surfaces — one thin component per kind of table, filling the chrome's slots
//              with that kind's verbs. This is where "a search result table has
//              Export and Save, an extraction table has Add column" lives, and
//              it is the only layer that should grow when a new kind arrives.

export { DataTable } from "./DataTable";
export type { DataTableProps } from "./DataTable";

export { useTableState } from "./useTableState";
export type { TableState, UseTableStateOptions } from "./useTableState";

export {
    EMPTY_CELL,
    DENSITY_LABELS,
    TABLE_DENSITIES,
    columnTypeIcon,
    defaultColumnWidth,
    renderPlainText,
} from "./tableView";
export type { TableDensity, TextRenderer } from "./tableView";

export { CellView, CellValueView, DetailsView, revealHandler } from "./cells";
export type { CellViewProps, CellValueViewProps } from "./cells";

export { ColumnHeaderCell } from "./columnHeader";
export type { ColumnHeaderCellProps } from "./columnHeader";

export { RowActionsView, tableHasRowActions } from "./rowActions";

export { TableSurface, csvForCurrentView } from "./chrome/TableSurface";
export type { TableSurfaceProps } from "./chrome/TableSurface";

export {
    TableTitleBar,
    TableSelectionBar,
    TableFooter,
} from "./chrome/TableBars";
export type {
    TableTitleBarProps,
    TableSelectionBarProps,
    TableFooterProps,
} from "./chrome/TableBars";

export { TableToolbar } from "./chrome/TableToolbar";
export type { TableToolbarProps } from "./chrome/TableToolbar";

export { AddColumnDialog } from "./chrome/AddColumnDialog";
export type {
    AddColumnDialogProps,
    ColumnDraft,
} from "./chrome/AddColumnDialog";

export { SearchResultsTable } from "./surfaces/SearchResultsTable";
export type { SearchResultsTableProps } from "./surfaces/SearchResultsTable";

export { ExtractionTable } from "./surfaces/ExtractionTable";
export type { ExtractionTableProps } from "./surfaces/ExtractionTable";
