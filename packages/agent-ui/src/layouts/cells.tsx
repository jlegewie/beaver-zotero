import React from "react";
import {
    anchorColumn,
    annotationComment,
    annotationTitle,
    annotationTypeLabel,
    columnWrap,
    type Cell,
    type CellValue,
    type Column,
    type Details,
    type Row,
    type SelectColor,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import { itemTypeToIconName } from "@beaver/agent-core/types/citations";
import { getHost } from "../host";
import {
    AlertCircleIcon,
    EditIcon,
    FileIcon,
    HighlighterIcon,
    Icon,
    NoteIcon,
    PictureInPictureIcon,
    TextAlignLeftIcon,
    TickIcon,
} from "../icons";
import { anchorActionHandler } from "./rowActionHandlers";
import { type TextRenderer } from "./tableView";

/**
 * Where a cell is drawn. In the grid a value is compact and clamped; in the
 * expanded row it has room, and an anchor cell hands its long parts (an
 * annotation's passage and comment) to labelled fields of their own.
 */
export type CellVariant = "cell" | "detail";

/**
 * One cell, in four states that must not be confused with one another:
 *
 * - **pending** — a producer is still filling it. A shimmer block sized like
 *   the text that is coming, not a spinner: a filling column would otherwise
 *   strobe once it has more than a handful of rows.
 * - **error** — the reason in words, with the retry the caller supplies. Never
 *   a red wash and never a dimmed row: dimming hides the data that did arrive.
 * - **empty** — an em dash. In an extraction table this is a finding ("the
 *   paper does not report this"), so it has to read as a value.
 * - **filled** — the value, clamped to the row height unless the column opts
 *   out with `wrap: "nowrap"`.
 */

export interface CellViewProps {
    cell: Cell | undefined;
    column: Column;
    row: Row;
    /** The table the row belongs to; decides which verb the anchor cell carries. */
    table: TableSpec;
    variant?: CellVariant;
    renderText: TextRenderer;
    /** Clicking a select pill filters by it, where the table allows filtering. */
    onSelectClick?: (label: string) => void;
    /** Offered next to a cell-level error when the surface can re-run one cell. */
    onRetry?: () => void;
}

export function CellView({
    cell,
    column,
    row,
    table,
    variant = "cell",
    renderText,
    onSelectClick,
    onRetry,
}: CellViewProps): React.ReactElement {
    if (cell?.status === "pending") return <PendingCell />;
    if (cell?.status === "error")
        return <ErrorCell message={cell.error} onRetry={onRetry} />;

    // Nothing at all, rather than a placeholder glyph. A column of em dashes
    // reads as noise across a wide table; the footer is where the count of
    // what is missing belongs.
    if (!cell?.value) return <span className="bt-empty" />;

    return (
        <span
            className={[
                "bt-value",
                overflowClass(cell.value, column),
                cell.provenance === "user" ? "bt-edited" : "",
            ]
                .filter(Boolean)
                .join(" ")}
        >
            <CellValueView
                value={cell.value}
                column={column}
                row={row}
                table={table}
                variant={variant}
                renderText={renderText}
                onSelectClick={onSelectClick}
            />
            {cell.provenance === "user" ? (
                <span className="bt-edit-mark" title="Edited by you">
                    <Icon icon={EditIcon} size={11} />
                </span>
            ) : null}
        </span>
    );
}

/**
 * Only prose clamps. A reference cell does its own clamping inside (title over
 * subtitle), and a number, date, pill or link is a single short token that
 * should ellipsise rather than wrap — clamping those would break their layout
 * for no gain.
 */
function overflowClass(value: CellValue, column: Column): string {
    if (value.kind === "reference" || value.kind === "annotation") return "";
    // Prose and links both wrap: a DOI is long enough that one ellipsised line
    // shows the prefix every row shares and none of what tells them apart.
    if (value.kind === "text" || value.kind === "link")
        return columnWrap(column) === "clamp" ? "bt-clamp" : "bt-nowrap";
    return "bt-nowrap";
}

function PendingCell(): React.ReactElement {
    return (
        <span className="bt-pending" role="img" aria-label="Filling">
            <span className="bt-skeleton" style={{ width: "92%" }} />
            <span className="bt-skeleton" style={{ width: "68%" }} />
        </span>
    );
}

function ErrorCell({
    message,
    onRetry,
}: {
    message?: string;
    onRetry?: () => void;
}): React.ReactElement {
    return (
        <span className="bt-cell-error">
            <span className="bt-cell-error-mark" aria-hidden="true">
                <Icon icon={AlertCircleIcon} size={13} />
            </span>
            <span className="bt-cell-error-text">
                {message ?? "Could not be extracted"}
                {onRetry ? (
                    <>
                        {" "}
                        <button
                            type="button"
                            className="bt-inline-link"
                            onClick={(e) => {
                                e.stopPropagation();
                                onRetry();
                            }}
                        >
                            Retry
                        </button>
                    </>
                ) : null}
            </span>
        </span>
    );
}

// ---------------------------------------------------------------------------
// Values, one renderer per CellValue kind
// ---------------------------------------------------------------------------

export interface CellValueViewProps {
    value: CellValue;
    column: Column;
    row: Row;
    table: TableSpec;
    variant?: CellVariant;
    renderText: TextRenderer;
    onSelectClick?: (label: string) => void;
}

export function CellValueView({
    value,
    column,
    row,
    table,
    variant = "cell",
    renderText,
    onSelectClick,
}: CellValueViewProps): React.ReactElement {
    switch (value.kind) {
        case "text":
            return <>{renderText(value.text)}</>;

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
                <span className="bt-number">
                    {value.display ?? value.value}
                </span>
            );

        case "boolean":
            // A check or a short dash, never a checkbox glyph: a checkbox reads
            // as editable, and false must not look like empty (an em dash).
            // A check for true and nothing for false: the check is the signal,
            // and a dash beside it only adds a second thing to read.
            return value.value ? (
                <span className="bt-bool-yes" role="img" aria-label="yes">
                    <Icon icon={TickIcon} size={14} />
                </span>
            ) : (
                <span className="bt-bool-no" role="img" aria-label="no" />
            );

        case "select":
            return (
                <SelectPill
                    label={value.label}
                    column={column}
                    onClick={onSelectClick}
                />
            );

        case "reference":
            return (
                <ReferenceValue
                    value={value}
                    row={row}
                    table={table}
                    isAnchor={anchorColumn(table)?.id === column.id}
                />
            );

        case "annotation":
            return (
                <AnnotationValue
                    value={value}
                    row={row}
                    table={table}
                    variant={variant}
                    isAnchor={anchorColumn(table)?.id === column.id}
                />
            );

        case "link": {
            const label = value.label ?? value.url;
            const navigation = getHost().navigation;
            if (!navigation)
                return <span className="bt-link-label">{label}</span>;
            const open = () => navigation.openExternalUrl(value.url);
            // A span, not a button: Gecko forces a button's computed display to
            // a flow root, which makes it an atomic box the cell's line clamp
            // cannot cut — a long DOI then ran to three lines and took the row
            // height with it.
            return (
                <span
                    className="bt-link"
                    role="link"
                    tabIndex={0}
                    title={value.url}
                    onClick={(e) => {
                        e.stopPropagation();
                        open();
                    }}
                    onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        e.stopPropagation();
                        open();
                    }}
                >
                    <span className="bt-link-label">{label}</span>
                </span>
            );
        }
    }
}

function selectColor(label: string, column: Column): SelectColor {
    return column.options?.find((o) => o.label === label)?.color ?? "gray";
}

function SelectPill({
    label,
    column,
    onClick,
}: {
    label: string;
    column: Column;
    onClick?: (label: string) => void;
}): React.ReactElement {
    const className = `bt-pill bt-pill-${selectColor(label, column)}`;
    if (!onClick) return <span className={className}>{label}</span>;
    return (
        <button
            type="button"
            className={`${className} bt-pill-button`}
            title={`Filter by ${label}`}
            onClick={(e) => {
                e.stopPropagation();
                onClick(label);
            }}
        >
            {label}
        </button>
    );
}

/**
 * The anchor cell for a bibliographic subject: a library item, an attachment,
 * an external reference or a file. All carry a display name, a subtitle and an
 * item type, so they render identically here — only the row's verbs differ,
 * and those come from the row's kind (`anchorActionHandler`).
 */
function ReferenceValue({
    value,
    row,
    table,
    isAnchor,
}: {
    value: Extract<CellValue, { kind: "reference" }>;
    row: Row;
    table: TableSpec;
    isAnchor: boolean;
}): React.ReactElement {
    const host = getHost();
    const iconName = itemTypeToIconName(value.item_type, value.content_kind);
    const hostIcon = host.components?.itemTypeIcon({
        itemType: iconName,
        className: "bt-ref-icon",
    });
    return (
        <SubjectValue
            row={row}
            table={table}
            isAnchor={isAnchor}
            icon={
                hostIcon ?? (
                    <Icon icon={FileIcon} size={15} className="bt-ref-icon" />
                )
            }
            title={value.display_name}
            meta={
                value.subtitle || value.venue ? (
                    <>
                        {value.subtitle ? (
                            <span className="bt-ref-authors">
                                {value.subtitle}
                            </span>
                        ) : null}
                        {value.venue ? (
                            <span className="bt-ref-venue">{value.venue}</span>
                        ) : null}
                    </>
                ) : null
            }
        />
    );
}

/** Glyph for an annotation type; the highlight colour tints it. */
function annotationIcon(
    type: string | undefined,
): React.ComponentType<React.SVGProps<SVGSVGElement>> {
    switch (type) {
        case "highlight":
        case "underline":
            return HighlighterIcon;
        case "image":
            return PictureInPictureIcon;
        case "text":
            return TextAlignLeftIcon;
        default:
            return NoteIcon;
    }
}

/**
 * The anchor cell for an annotation. In the grid the passage is the title,
 * drawn as a quote with a bar in the annotation's colour, and the comment
 * follows in plain type; the source and page sit where a paper's authors
 * would. In the expanded row the passage and comment become labelled fields
 * of their own (`cellExpandedFields`), so here the cell names only what the
 * annotation is and where it sits.
 */
function AnnotationValue({
    value,
    row,
    table,
    variant,
    isAnchor,
}: {
    value: Extract<CellValue, { kind: "annotation" }>;
    row: Row;
    table: TableSpec;
    variant: CellVariant;
    isAnchor: boolean;
}): React.ReactElement {
    const meta = [
        value.source_display_name,
        value.page_label ? `p. ${value.page_label}` : undefined,
    ]
        .filter(Boolean)
        .join(" · ");
    const detail = variant === "detail";
    const quoted =
        !detail &&
        !!value.text &&
        value.annotation_type !== "note" &&
        value.annotation_type !== "image" &&
        value.annotation_type !== "ink";
    return (
        <SubjectValue
            row={row}
            table={table}
            isAnchor={isAnchor}
            icon={
                <Icon
                    icon={annotationIcon(value.annotation_type)}
                    size={15}
                    className="bt-ref-icon"
                    style={value.color ? { color: value.color } : undefined}
                />
            }
            title={
                detail
                    ? annotationTypeLabel(value.annotation_type)
                    : annotationTitle(value)
            }
            titleClassName={quoted ? "bt-ann-quote" : undefined}
            titleStyle={
                quoted && value.color ? { borderColor: value.color } : undefined
            }
            meta={meta ? <span className="bt-ref-authors">{meta}</span> : null}
            extra={
                !detail && annotationComment(value) ? (
                    <span className="bt-ann-comment">
                        {annotationComment(value)}
                    </span>
                ) : null
            }
            actionLabel="Open in reader"
        />
    );
}

/**
 * The shared frame of a subject cell: icon, title and a meta line. In the anchor
 * column the title also performs the row's primary verb, because it is the
 * row's commonest action and finding it elsewhere costs a hunt per row — only
 * where the table declares it and the host can perform it. The row's full set
 * of verbs is mounted beside this by the grid (`RowActionsView`), on the anchor
 * cell rather than on its value, so it survives a pending or failed anchor.
 */
function SubjectValue({
    row,
    table,
    isAnchor,
    icon,
    title,
    titleClassName,
    titleStyle,
    meta,
    extra,
    actionLabel = "Reveal in library",
}: {
    row: Row;
    table: TableSpec;
    isAnchor: boolean;
    icon: React.ReactNode;
    title: string;
    titleClassName?: string;
    titleStyle?: React.CSSProperties;
    meta: React.ReactNode;
    extra?: React.ReactNode;
    actionLabel?: string;
}): React.ReactElement {
    const act = isAnchor ? anchorActionHandler(table, row) : undefined;
    const titleClass = ["bt-ref-title", titleClassName]
        .filter(Boolean)
        .join(" ");
    return (
        <span className="bt-reference">
            <span className="bt-ref-icon-slot" aria-hidden="true">
                {icon}
            </span>
            <span className="bt-ref-body">
                {/*
                 * The clamp lives on the inner span even when the title is a
                 * button: Gecko forces a button's computed `display` to a
                 * flow root, and `-webkit-line-clamp` never reaches the
                 * anonymous block inside it — the title then wraps to its full
                 * length and takes the row's height with it.
                 */}
                {act ? (
                    <button
                        type="button"
                        className="bt-ref-title-button"
                        title={actionLabel}
                        onClick={(e) => {
                            e.stopPropagation();
                            act();
                        }}
                    >
                        <span className={titleClass} style={titleStyle}>
                            {title}
                        </span>
                    </button>
                ) : (
                    <span className={titleClass} style={titleStyle}>
                        {title}
                    </span>
                )}
                {meta ? <span className="bt-ref-meta">{meta}</span> : null}
                {extra}
            </span>
        </span>
    );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/** The expandable part of a cell or a column header, shown in the row detail. */
export function DetailsView({
    details,
    label,
    renderText,
}: {
    details: Details;
    label?: string;
    renderText: TextRenderer;
}): React.ReactElement {
    const heading = details.label ?? label;
    return (
        <div className="bt-details">
            {heading ? <div className="bt-details-label">{heading}</div> : null}
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
