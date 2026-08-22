import React from "react";
import {
    cellIdFor,
    type Cell,
    type CellDetails,
    type CellValue,
    type Column,
    type Row,
    type RowAction,
    type RowRef,
    type SelectColor,
} from "@beaver/agent-core/layouts/table";
import { itemTypeToIconName } from "@beaver/agent-core/types/citations";
import { getHost } from "../host";
import {
    AlertCircleIcon,
    ArrowRightIcon,
    FileIcon,
    FileViewIcon,
    Icon,
    LibraryIcon,
    Spinner,
    TickIcon,
} from "../icons";
import IconButton from "../primitives/IconButton";

/** Renders a cell's text (markdown, possibly with citation tags). The default is plain text. */
export type TextRenderer = (text: string) => React.ReactNode;

export const renderPlainText: TextRenderer = (text) => text;

export const EMPTY_CELL = "—";

function selectColorClass(label: string, column: Column): string {
    const color: SelectColor =
        column.options?.find((o) => o.label === label)?.color ?? "gray";
    return `bt-select bt-select-${color}`;
}

/** The compact, always-visible rendering of a value. */
export function CellValueView({
    value,
    column,
    renderText,
    onSelectClick,
}: {
    value: CellValue;
    column: Column;
    renderText: TextRenderer;
    /** When given, select pills are clickable (filter by this label). */
    onSelectClick?: (label: string) => void;
}): React.ReactElement {
    switch (value.kind) {
        case "text":
            return <span className="bt-text">{renderText(value.text)}</span>;
        case "number":
            return (
                <span className="bt-number">
                    {value.display ?? value.value.toLocaleString()}
                    {column.unit && !value.display ? (
                        <span className="bt-unit">{column.unit}</span>
                    ) : null}
                </span>
            );
        case "date":
            return (
                <span className="bt-date">{value.display ?? value.value}</span>
            );
        case "boolean":
            return (
                <span
                    className={`bt-boolean${value.value ? " bt-boolean-true" : ""}`}
                    role="img"
                    aria-label={value.value ? "yes" : "no"}
                >
                    {value.value ? (
                        <Icon icon={TickIcon} size={14} />
                    ) : (
                        <span className="bt-boolean-false" />
                    )}
                </span>
            );
        case "select":
            return onSelectClick ? (
                <button
                    type="button"
                    className={`${selectColorClass(value.label, column)} bt-select-button`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onSelectClick(value.label);
                    }}
                    title={`Filter by ${value.label}`}
                >
                    {value.label}
                </button>
            ) : (
                <span className={selectColorClass(value.label, column)}>
                    {value.label}
                </span>
            );
        case "reference": {
            const inLibrary = (value.library_items?.length ?? 0) > 0;
            const iconName = itemTypeToIconName(value.item_type, undefined);
            const hostIcon = getHost().components?.itemTypeIcon({
                itemType: iconName,
                className: "bt-ref-icon",
            });
            return (
                <span className="bt-reference">
                    <span className="bt-ref-icon-slot" aria-hidden="true">
                        {hostIcon ?? (
                            <Icon
                                icon={FileIcon}
                                size={16}
                                className="bt-ref-icon"
                            />
                        )}
                    </span>
                    <span className="bt-ref-body">
                        <span className="bt-ref-name">
                            {value.display_name}
                            {inLibrary ? (
                                <span
                                    className="bt-ref-in-library"
                                    title="In your library"
                                >
                                    <Icon icon={LibraryIcon} size={12} />
                                </span>
                            ) : null}
                        </span>
                        {value.subtitle ? (
                            <span className="bt-ref-subtitle">
                                {value.subtitle}
                            </span>
                        ) : null}
                    </span>
                </span>
            );
        }
        case "link": {
            const label = value.label ?? value.url;
            const navigation = getHost().navigation;
            return navigation ? (
                <button
                    type="button"
                    className="bt-link text-link"
                    onClick={(e) => {
                        e.stopPropagation();
                        navigation.openExternalUrl(value.url);
                    }}
                    title={value.url}
                >
                    {label}
                </button>
            ) : (
                <a
                    className="bt-link text-link"
                    href={value.url}
                    target="_blank"
                    rel="noreferrer"
                >
                    {label}
                </a>
            );
        }
    }
}

/** One cell: status, value and the expand affordance when it has details. */
export function CellView({
    cell,
    column,
    row,
    renderText,
    expanded,
    onToggleExpand,
    onSelectClick,
}: {
    cell: Cell | undefined;
    column: Column;
    row: Row;
    renderText: TextRenderer;
    expanded: boolean;
    onToggleExpand?: (cellId: string) => void;
    onSelectClick?: (label: string) => void;
}): React.ReactElement {
    const cellId = cellIdFor(row.id, column.id);

    if (cell?.status === "pending") {
        return (
            <span className="bt-cell-pending" aria-label="Pending">
                <Spinner size={12} />
            </span>
        );
    }

    if (cell?.status === "error") {
        return (
            <span className="bt-cell-error" title={cell.error ?? "Error"}>
                <Icon icon={AlertCircleIcon} size={14} />
                <span className="bt-cell-error-text">
                    {cell.error ?? "Error"}
                </span>
            </span>
        );
    }

    const hasDetails = !!cell?.details && !!onToggleExpand;
    return (
        <span
            className={`bt-cell-inner${hasDetails ? " bt-cell-expandable" : ""}`}
        >
            {cell?.value ? (
                <CellValueView
                    value={cell.value}
                    column={column}
                    renderText={renderText}
                    onSelectClick={onSelectClick}
                />
            ) : (
                <span className="bt-empty" aria-label="No value">
                    {EMPTY_CELL}
                </span>
            )}
            {hasDetails ? (
                <IconButton
                    icon={ArrowRightIcon}
                    variant="ghost-secondary"
                    className={`bt-expand${expanded ? " bt-expand-open" : ""}`}
                    ariaLabel={expanded ? "Hide details" : "Show details"}
                    ariaPressed={expanded}
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpand(cellId);
                    }}
                />
            ) : null}
        </span>
    );
}

/** The expandable part of a cell, rendered in the detail row under its table row. */
export function CellDetailsView({
    details,
    column,
    renderText,
}: {
    details: CellDetails;
    column: Column;
    renderText: TextRenderer;
}): React.ReactElement {
    const label = details.label ?? column.header;
    return (
        <div className="bt-details">
            <div className="bt-details-label">{label}</div>
            {details.kind === "text" ? (
                <div className="bt-details-text">
                    {renderText(details.text)}
                </div>
            ) : (
                <ul className="bt-details-list">
                    {details.items.map((item, i) => (
                        <li key={i}>{renderText(item)}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Row actions resolved against the row's reference. External references use
 * the host's own action buttons (import / reveal are library writes and
 * navigations); library items map to the navigation slice. Without a host
 * slice, nothing is rendered — never a dead control.
 */
export function RowActionsView({
    rowRef: ref,
    actions,
}: {
    rowRef: RowRef | undefined;
    actions: RowAction[];
}): React.ReactElement | null {
    const host = getHost();
    if (!ref || actions.length === 0) return null;

    if (ref.kind === "external") {
        if (!ref.reference || !host.components) return null;
        const mode = (action: RowAction) =>
            actions.includes(action) ? "icon-only" : "none";
        return (
            <>
                {host.components.externalReferenceActions({
                    item: ref.reference,
                    buttonVariant: "ghost-secondary",
                    importButtonMode: mode("import"),
                    revealButtonMode: mode("reveal"),
                    pdfButtonMode: mode("open"),
                    detailsButtonMode: "none",
                    webButtonMode: "none",
                    showCitationCount: false,
                })}
            </>
        );
    }

    const navigation = host.navigation;
    if (!navigation) return null;
    const itemRef = {
        library_id: ref.library_id,
        zotero_key: ref.zotero_key,
        library_ref: ref.library_ref,
    };
    const revealIcon = host.components?.revealInLibraryIcon({
        className: "bt-action-icon",
    });
    return (
        <>
            {actions.includes("reveal") ? (
                <IconButton
                    icon={revealIcon ? () => <>{revealIcon}</> : LibraryIcon}
                    variant="ghost-secondary"
                    ariaLabel="Reveal in library"
                    title="Reveal in library"
                    onClick={(e) => {
                        e.stopPropagation();
                        navigation.revealInLibrary(itemRef);
                    }}
                />
            ) : null}
            {actions.includes("open") ? (
                <IconButton
                    icon={FileViewIcon}
                    variant="ghost-secondary"
                    ariaLabel="Open"
                    title="Open"
                    onClick={(e) => {
                        e.stopPropagation();
                        void navigation.openSource(itemRef);
                    }}
                />
            ) : null}
        </>
    );
}
