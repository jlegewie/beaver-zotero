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
import { ChipPopupCard } from "../../chat/ChipPopup";
import { getHost } from "../../host";
import { FileIcon, Icon, MoreHorizontalIcon } from "../../icons";
import MenuButton from "../../primitives/MenuButton";
import type { MenuItem } from "../../primitives/ContextMenu";
import { useHoverAnchor } from "../../primitives/HoverLayer";
import { rowActionHandler } from "../rowActionHandlers";
import { RowImportAction } from "../rowActions";
import { documentKindLabel, documentNoun, type TableDocuments } from "./cellModel";

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

/** The paper's title, and its authors and venue as one line. */
export function paperText(
    row: Row,
    /** The anchor column, whose value names a row that has no reference. */
    anchorColumnId?: string,
): { title: string; meta: string; year?: string } {
    const reference = rowReference(row);
    const year = cellValueText(row.cells[YEAR_COLUMN_ID]?.value) || undefined;
    const anchorText = !reference && anchorColumnId ? cellValueText(row.cells[anchorColumnId]?.value) : "";
    return {
        title: reference?.title ?? reference?.display_name ?? (anchorText || "Untitled"),
        meta: [reference?.subtitle, reference?.venue].filter(Boolean).join(" · "),
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
 * The Paper cell: title over authors · venue, a "New paper" tag on a row added
 * since the last fill, and the row's failure when its fill could not read it.
 * Hovering shows the paper card; the row's actions sit on its top-right
 * corner on hover.
 */
export function PaperCell({
    table,
    row,
    anchorColumnId,
    isNew,
    documents,
    menuItems,
}: {
    /** The table, for the row actions it declares (import). */
    table?: TableSpec;
    row: Row;
    anchorColumnId?: string;
    isNew: boolean;
    documents?: TableDocuments;
    /** The row's actions; the menu is omitted when there are none. */
    menuItems: MenuItem[];
}): React.ReactElement {
    const { title, meta } = paperText(row, anchorColumnId);
    const hover = useHoverAnchor({
        slot: "card",
        variant: "card",
        width: 312,
        render: () => <PaperCard row={row} anchorColumnId={anchorColumnId} documents={documents} isNew={isNew} />,
    });
    return (
        <div className="rt-paper">
            <span className="rt-paper-icon" aria-hidden="true">
                <PaperIcon row={row} />
            </span>
            <div
                className="rt-paper-body"
                // Keyboard focus shows the card; its actions are also in the row menu.
                tabIndex={0}
                {...hover}
            >
                <span className="rt-paper-title">{title}</span>
                {meta ? <span className="rt-paper-meta">{meta}</span> : null}
                {row.failure ? (
                    <span className="rt-row-flags">
                        <span className="rt-tag rt-tag-failed" title={row.failure.message}>
                            {row.failure.code === "no_source" ? "Nothing to read" : "Couldn't be read"}
                        </span>
                    </span>
                ) : isNew ? (
                    <span className="rt-row-flags">
                        <span className="rt-tag rt-tag-new" title="Added since the last fill">
                            New paper
                        </span>
                    </span>
                ) : null}
            </div>
            {table ? <RowImportAction table={table} row={row} /> : null}
            {menuItems.length ? (
                <MenuButton
                    menuItems={menuItems}
                    variant="ghost-secondary"
                    icon={MoreHorizontalIcon}
                    className="rt-row-menu"
                    ariaLabel="Row actions"
                />
            ) : null}
        </div>
    );
}

/**
 * The paper's hover card: the chat's item chip card for the work, the row's
 * document, and Show in library and Open.
 */
export function PaperCard({
    row,
    anchorColumnId,
    documents,
    isNew = false,
}: {
    row: Row;
    anchorColumnId?: string;
    documents?: TableDocuments;
    /** A row added since the last fill. */
    isNew?: boolean;
}): React.ReactElement {
    const { title, meta, year } = paperText(row, anchorColumnId);
    const reference = rowReference(row);
    const navigation = getHost().navigation;
    const item = rowItemReference(row);
    const documentId = row.documents?.[0];
    const info = documentId ? documents?.get(documentId) : undefined;
    const open = paperOpenAction(row, documents);
    const subtitle = [reference?.subtitle, year, reference?.venue].filter(Boolean).join(" · ");
    return (
        <div className="rt-card rt-paper-card">
            <ChipPopupCard
                icon={<PaperIcon row={row} />}
                title={title}
                subtitle={subtitle || meta ? { text: subtitle || meta } : null}
            />
            <div className="rt-paper-card-document">
                <Icon icon={FileIcon} size={14} />
                <div className="rt-paper-card-document-text">
                    {documentId ? (
                        <>
                            <span className="rt-paper-card-file">{info?.name ?? "Document"}</span>
                            <span className="rt-paper-card-note">
                                Answers in this row are read from {documentNoun(info?.kind).replace(/^the /, "this ")}
                            </span>
                        </>
                    ) : (
                        <>
                            <span className="rt-paper-card-file">No document</span>
                            <span className="rt-paper-card-note">
                                Answers in this row come from the title and abstract
                            </span>
                        </>
                    )}
                </div>
            </div>
            {row.failure ? (
                <div className="rt-paper-card-failure">{row.failure.message}</div>
            ) : isNew ? (
                <div className="rt-paper-card-note rt-paper-card-new">New paper: added since the last fill.</div>
            ) : null}
            {navigation && (item || open) ? (
                <div className="rt-card-actions">
                    {item ? (
                        <button
                            type="button"
                            className="rt-card-button"
                            onClick={() => navigation.revealInLibrary(item)}
                        >
                            Show in library
                        </button>
                    ) : null}
                    {open ? (
                        <button type="button" className="rt-card-button" onClick={open.run}>
                            {open.label}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
