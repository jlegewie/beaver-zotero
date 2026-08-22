// The shared layout renderers. Like the other barrels, this is the root the
// closure check starts from; consumers import a component by its own subpath
// (`@beaver/agent-ui/layouts/DataTable`).

export { default as DataTable } from "./DataTable";
export type { DataTableProps, TableDensity } from "./DataTable";

export { useTableState } from "./useTableState";
export type { TableState } from "./useTableState";

export {
    CellView,
    CellValueView,
    CellDetailsView,
    RowActionsView,
    renderPlainText,
    EMPTY_CELL,
} from "./cells";
export type { TextRenderer } from "./cells";
