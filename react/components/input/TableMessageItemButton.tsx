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
        <span className="display-flex items-center gap-1">
            <TableChip
                tableKey={key}
                title={
                    current?.status === "available"
                        ? current.title
                        : String(item.getField("title") || "Table")
                }
                remove={onRemove ? { onRemove, onRemoveAll } : undefined}
            />
            {current?.status === "unavailable" && (
                <span role="status" className="text-xs">
                    {current.reason}
                </span>
            )}
        </span>
    );
}
