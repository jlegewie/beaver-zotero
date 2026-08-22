import React from "react";
import type { TableCoverage } from "@beaver/agent-core/layouts/table";
import { Icon } from "../../icons";
import Button from "../../primitives/Button";

/**
 * The thin presentational bars a table surface is built from: the title bar at
 * the top, the selection bar that replaces the toolbar while rows are picked,
 * and the footer that states what the viewer is actually looking at.
 *
 * None of them know what kind of table they sit on — every label and every
 * verb arrives as a prop, which is what lets one surface serve search results
 * and an extraction table alike.
 */

export interface TableTitleBarProps {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    /** Small mark to the left of the title; a table glyph by default. */
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** Verbs that act on the whole table: export, save to library. */
    actions?: React.ReactNode;
}

export function TableTitleBar({
    title,
    subtitle,
    icon,
    actions,
}: TableTitleBarProps): React.ReactElement {
    return (
        <header className="bt-titlebar">
            <div className="bt-titleblock">
                {icon ? (
                    <span className="bt-titlemark" aria-hidden="true">
                        <Icon icon={icon} size={15} />
                    </span>
                ) : null}
                <div className="bt-titletext">
                    <div className="bt-title">{title}</div>
                    {subtitle ? (
                        <div className="bt-subtitle">{subtitle}</div>
                    ) : null}
                </div>
            </div>
            {actions ? <div className="bt-titleactions">{actions}</div> : null}
        </header>
    );
}

export interface TableSelectionBarProps {
    count: number;
    /** Bulk verbs for the selection. Absent ⇒ only the count and Clear. */
    actions?: React.ReactNode;
    onClear(): void;
    /** What one row is called here — "item", "paper", "row". */
    noun?: string;
}

export function TableSelectionBar({
    count,
    actions,
    onClear,
    noun = "row",
}: TableSelectionBarProps): React.ReactElement {
    return (
        <div className="bt-selectionbar">
            <span className="bt-selectioncount" role="status">
                {count} {count === 1 ? noun : `${noun}s`} selected
            </span>
            {actions}
            <span className="bt-spacer" />
            <Button variant="ghost-secondary" onClick={onClear}>
                Clear
            </Button>
        </div>
    );
}

export interface TableFooterProps {
    /** Rows in view, and in total when a filter narrows them. */
    shown: number;
    total: number;
    /** Human sentence for the active sort; absent when nothing is sorted. */
    sortLabel?: string;
    coverage: TableCoverage;
    /** Anything the surface wants to add — a schema hash, a last-updated time. */
    note?: React.ReactNode;
}

/**
 * The footer states coverage, not decoration. A review table that quietly drops
 * the papers it failed on is worse than useless, so what is missing is reported
 * beside what is there.
 */
export function TableFooter({
    shown,
    total,
    sortLabel,
    coverage,
    note,
}: TableFooterProps): React.ReactElement {
    const parts: React.ReactNode[] = [];

    parts.push(
        shown === total
            ? `${total} ${total === 1 ? "row" : "rows"}`
            : `${shown} of ${total} rows`,
    );
    if (sortLabel) parts.push(sortLabel);
    if (coverage.pending > 0) parts.push(`${coverage.pending} filling`);
    if (coverage.empty > 0) parts.push(`${coverage.empty} not reported`);
    if (coverage.error > 0) parts.push(`${coverage.error} failed`);
    if (coverage.errorRows > 0)
        parts.push(
            `${coverage.errorRows} ${coverage.errorRows === 1 ? "row" : "rows"} incomplete`,
        );
    if (note) parts.push(note);

    return (
        <footer className="bt-footer">
            {parts.map((part, i) => (
                <React.Fragment key={i}>
                    {i > 0 ? (
                        <span className="bt-dot" aria-hidden="true" />
                    ) : null}
                    <span>{part}</span>
                </React.Fragment>
            ))}
        </footer>
    );
}
