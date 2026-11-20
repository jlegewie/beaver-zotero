import React from "react";
import { useTableDisplay } from "../../hooks/useTableDisplay";
import { TableChip } from "../agentRuns/requestChips/RequestChipPrimitives";
import { libraryRefForLibraryID } from "../../../src/utils/libraryIdentity";

export function TableMessageItemButton({
    item,
    onRemove,
    onRemoveAll,
}: {
    item: Zotero.Item;
    onRemove?: () => void;
    onRemoveAll?: () => void;
}) {
    const key = `${libraryRefForLibraryID(item.libraryID)}-${item.key}`;
    const current = useTableDisplay(key);
    return (
        <TableChip
            tableKey={key}
            title={
                current?.status === "available"
                    ? current.title
                    : String(item.getField("title") || "Table")
            }
            unavailable={current?.status === "unavailable" ? current : null}
            remove={onRemove ? { onRemove, onRemoveAll } : undefined}
        />
    );
}
