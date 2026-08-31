import React from "react";
import type { Row, TableSpec } from "@beaver/agent-core/layouts/table";
import { BookSearchIcon, ImportIcon } from "../../icons";
import Button from "../../primitives/Button";
import { TableSurface, type TableSurfaceProps } from "../chrome/TableSurface";
import { TableHeaderActions } from "../chrome/TableBars";
import { useTableState } from "../useTableState";
import type { TextRenderer } from "../tableView";

export interface SearchResultsTableProps {
    table: TableSpec;
    /** Where the results came from — "Semantic Scholar · 9 results". */
    subtitle?: React.ReactNode;
    /** Receives the CSV of the current view. Absent ⇒ no export control. */
    onExport?: (csv: string, table: TableSpec) => void;
    /** Adds a selection to the library. Absent ⇒ no bulk import control. */
    onImportRows?: (rows: Row[]) => void;
    /** Reveals the table's own library item. Absent ⇒ no control. */
    onShowInLibrary?: (table: TableSpec) => void;
    renderText?: TextRenderer;
    density?: TableSurfaceProps["density"];
    /** Narrow surface: carry the primary columns only. */
    primaryColumnsOnly?: boolean;
    className?: string;
}

/**
 * A table of search results: rows the user scans, sorts and imports.
 *
 * It is a view — nothing here changes the underlying data, and importing a row
 * goes through the host's approval pipeline like any other library write. The
 * chrome is the whole difference from an extraction table: export and reveal
 * instead of add-column, and no per-column menus, because the columns are the
 * producer's and not the user's.
 *
 * Every verb is optional. A caller that cannot export simply passes no
 * `onExport`, and the control is absent rather than present and dead.
 */
export function SearchResultsTable({
    table,
    subtitle,
    onExport,
    onImportRows,
    onShowInLibrary,
    renderText,
    density,
    primaryColumnsOnly,
    className,
}: SearchResultsTableProps): React.ReactElement {
    const state = useTableState(table, { density });

    return (
        <TableSurface
            table={table}
            state={state}
            icon={BookSearchIcon}
            subtitle={subtitle}
            rowNoun="item"
            renderText={renderText}
            primaryColumnsOnly={primaryColumnsOnly}
            className={className}
            emptyText="No results"
            headerActions={
                <TableHeaderActions
                    table={table}
                    state={state}
                    onExport={onExport}
                    onShowInLibrary={onShowInLibrary}
                />
            }
            selectionActions={(_ids, rows) =>
                onImportRows ? (
                    <Button
                        variant="surface"
                        icon={ImportIcon}
                        onClick={() => onImportRows(rows)}
                    >
                        Add to library
                    </Button>
                ) : null
            }
        />
    );
}

export default SearchResultsTable;
