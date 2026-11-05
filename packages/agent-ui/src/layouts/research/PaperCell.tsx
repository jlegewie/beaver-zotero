import React from "react";
import {
    cellValueText,
    YEAR_COLUMN_ID,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { documentReference } from "@beaver/agent-core/layouts/rowActions";
import { rowReference } from "@beaver/agent-core/layouts/tableCitations";
import { itemTypeToIconName } from "@beaver/agent-core/types/citations";
import type { ZoteroItemReference } from "@beaver/agent-core/types/zotero";
import { getHost } from "../../host";
import { FileIcon, Icon, LibraryIcon, MoreHorizontalIcon } from "../../icons";
import MenuButton from "../../primitives/MenuButton";
import type { MenuItem } from "../../primitives/ContextMenu";
import { rowActionHandler } from "../rowActionHandlers";
import { rowImportControl } from "../rowActions";
import { documentKindLabel, type TableDocuments } from "./cellModel";

/** The row's own item, as the host's navigation names it. */
export function rowItemReference(row: Row): ZoteroItemReference | undefined {
    const ref = row.ref;
    if (ref?.kind !== "item") return undefined;
    return {
        library_id: ref.library_id ?? 0,
        zotero_key: ref.zotero_key,
        library_ref: ref.library_ref,
    };
}

/** The paper's title, authors, venue and year. */
export function paperText(
    row: Row,
    /** The anchor column, whose value names a row that has no reference. */
    anchorColumnId?: string,
): { title: string; authors?: string; venue?: string; year?: string } {
    const reference = rowReference(row);
    const year = cellValueText(row.cells[YEAR_COLUMN_ID]?.value) || undefined;
    const anchorText = !reference && anchorColumnId ? cellValueText(row.cells[anchorColumnId]?.value) : "";
    return {
        title: reference?.title ?? reference?.display_name ?? (anchorText || "Untitled"),
        ...(reference?.subtitle ? { authors: reference.subtitle } : {}),
        ...(reference?.venue ? { venue: reference.venue } : {}),
        ...(year ? { year } : {}),
    };
}

/**
 * The row's Open: its document, else the item's best attachment, which the
 * host picks when clicked. Offered by the paper card and the row menu alike.
 */
export function paperOpenAction(
    row: Row,
    documents?: TableDocuments,
): { label: string; run: () => void } | undefined {
    const navigation = getHost().navigation;
    if (!navigation) return undefined;
    const documentId = row.documents?.[0];
    const documentRef = documentReference(documentId);
    if (documentRef)
        return {
            label: `Open ${documentKindLabel(documentId ? documents?.get(documentId)?.kind : undefined)}`,
            run: () => void navigation.openSource(documentRef),
        };
    const handler = rowActionHandler(row, "open");
    return handler ? { label: "Open", run: handler } : undefined;
}

function PaperIcon({ row, className }: { row: Row; className?: string }): React.ReactElement {
    const reference = rowReference(row);
    const hostIcon = getHost().components?.itemTypeIcon({
        itemType: itemTypeToIconName(reference?.item_type, undefined),
        className,
    });
    return <>{hostIcon ?? <Icon icon={FileIcon} size={15} className={className} />}</>;
}

/**
 * The Paper cell's content: the title, the authors, the venue in italics on
 * its own line (when the row height leaves room), a "New paper" tag on a row
 * added since the last fill, and the row's failure when its fill could not
 * read it. `full` is the cell's expansion (the peek): nothing clamped, the
 * year after the venue (the Year column scrolls away when the table does),
 * and the failure's message. The grid's cell owns the click, the keyboard and
 * the expansion.
 */
export function PaperCell({
    row,
    anchorColumnId,
    isNew,
    full = false,
}: {
    row: Row;
    anchorColumnId?: string;
    isNew: boolean;
    full?: boolean;
}): React.ReactElement {
    const { title, authors, venue, year } = paperText(row, anchorColumnId);
    const flagged = !!row.failure || isNew;
    const shownYear = full ? year : undefined;
    return (
        <div className={["rt-paper", full ? "rt-paper-full" : "", flagged ? "rt-paper-flagged" : ""].filter(Boolean).join(" ")}>
            <span className="rt-paper-icon" aria-hidden="true">
                <PaperIcon row={row} />
            </span>
            <div className="rt-paper-body">
                <span className="rt-paper-title">{title}</span>
                {authors ? <span className="rt-paper-meta">{authors}</span> : null}
                {venue || shownYear ? (
                    <span className="rt-paper-meta rt-paper-venue">
                        {venue ? <em>{venue}</em> : null}
                        {venue && shownYear ? " · " : null}
                        {shownYear}
                    </span>
                ) : null}
                {row.failure ? (
                    <span className="rt-row-flags">
                        <span className="rt-tag rt-tag-failed" title={full ? undefined : row.failure.message}>
                            {row.failure.code === "no_source" ? "Nothing to read" : "Couldn't be read"}
                        </span>
                    </span>
                ) : isNew ? (
                    <span className="rt-row-flags">
                        <span className="rt-tag rt-tag-new" title="Added since the last fill">
                            New item
                        </span>
                    </span>
                ) : null}
                {full && row.failure ? <span className="rt-paper-failure">{row.failure.message}</span> : null}
            </div>
        </div>
    );
}

/**
 * The row's actions as buttons: the table's import (an external work), Show
 * in library and Open, each when the host can do it, then the row's menu.
 * Nothing when there are none. Shared by the Paper cell's expansion and the
 * paper view. `onAction` runs before each (the expansion closes itself).
 */
export function PaperActions({
    table,
    row,
    documents,
    menuItems = [],
    onAction,
    className,
    buttonClassName,
}: {
    /** The table, for the row actions it declares (import). */
    table?: TableSpec;
    row: Row;
    documents?: TableDocuments;
    /** The row's further actions, behind a menu button. */
    menuItems?: MenuItem[];
    onAction?: () => void;
    className: string;
    buttonClassName: string;
}): React.ReactElement | null {
    const navigation = getHost().navigation;
    const item = navigation ? rowItemReference(row) : undefined;
    const open = paperOpenAction(row, documents);
    const importControl = table ? rowImportControl(table, row) : null;
    if (importControl == null && !item && !open && !menuItems.length) return null;
    const run = (action: () => void) => () => {
        onAction?.();
        action();
    };
    return (
        <div className={className} onClick={stopPropagation}>
            {importControl != null ? <span className="rt-row-import">{importControl}</span> : null}
            {item && navigation ? (
                <button
                    type="button"
                    className={buttonClassName}
                    onClick={run(() => navigation.revealInLibrary(item))}
                >
                    <Icon icon={LibraryIcon} size={12} />
                    Show in library
                </button>
            ) : null}
            {open ? (
                <button type="button" className={buttonClassName} onClick={run(open.run)}>
                    <Icon icon={FileIcon} size={12} />
                    {open.label}
                </button>
            ) : null}
            {menuItems.length ? (
                <MenuButton
                    menuItems={onAction ? menuItems.map((entry) => withBefore(entry, onAction)) : menuItems}
                    // No button variant: the class styles it like its neighbours.
                    variant="rt"
                    icon={MoreHorizontalIcon}
                    className={`${buttonClassName} rt-row-menu`}
                    ariaLabel="Row actions"
                />
            ) : null}
        </div>
    );
}

/** A menu entry that runs `before` first; a submenu's parent only opens it, so its entries do. */
function withBefore(entry: MenuItem, before: () => void): MenuItem {
    if (entry.isDivider) return entry;
    if (entry.submenu) return { ...entry, submenu: entry.submenu.map((sub) => withBefore(sub, before)) };
    return {
        ...entry,
        onClick: () => {
            before();
            entry.onClick();
        },
    };
}

const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();
