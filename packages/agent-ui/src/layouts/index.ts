// The shared layout renderers. Like the other barrels, this is the root the
// closure check starts from; consumers import a component by its own subpath
// (`@beaver/agent-ui/layouts/research/ResearchTable`).
//
// The research table (`research/`) renders every stored table. It draws its
// own grid and reuses the view state, row windowing, filter and sort menus and
// the row verbs from the modules beside it.

export { useTableState } from "./useTableState";
export type { TableState, UseTableStateOptions } from "./useTableState";

export { renderPlainText } from "./tableView";
export type { TableDensity, TextRenderer } from "./tableView";

export { RowImportAction } from "./rowActions";
export { rowActionHandler } from "./rowActionHandlers";

export { ResearchTable } from "./research/ResearchTable";
export type {
    NewPapersNotice,
    ResearchCellEditing,
    ResearchColumnType,
    ResearchTableEditing,
    ResearchTableFill,
    ResearchTableFocus,
    ResearchTableProps,
} from "./research/ResearchTable";
export { CellInspector } from "./research/CellInspector";
export { CellEditor, editsAsList } from "./research/CellEditor";
export type { CellEditInput } from "./research/CellEditor";
export type { CellInspectorProps, InspectorView } from "./research/CellInspector";
export {
    cellState,
    cellTags,
    columnBadges,
    documentNoun,
    evidenceTagLabel,
    inspectorContent,
    isNewRow,
    newBadgeText,
    researchColumns,
    rowDocumentLine,
    staleBadgeText,
    tagDefinition,
} from "./research/cellModel";
export type {
    CellState,
    CellTag,
    ColumnBadges,
    InspectorAnswer,
    InspectorContent,
    ResearchColumns,
    TableDocumentInfo,
    TableDocuments,
} from "./research/cellModel";
