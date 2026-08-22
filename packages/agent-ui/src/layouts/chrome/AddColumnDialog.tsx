import React, { useState } from "react";
import type {
    ColumnType,
    TableCostEstimate,
} from "@beaver/agent-core/layouts/table";
import { ClockIcon, Icon } from "../../icons";
import Button from "../../primitives/Button";

/** What the composer produces. Turning it into a column is the caller's job. */
export interface ColumnDraft {
    header: string;
    type: ColumnType;
    /** The question Beaver runs against every row — the extraction prompt. */
    description: string;
}

export interface AddColumnDialogProps {
    /** Rows the run would cover; the cost line is stated in terms of it. */
    rowCount: number;
    costEstimate?: TableCostEstimate;
    onSubmit(draft: ColumnDraft): void;
    onCancel(): void;
    /** Prefill, for editing an existing column rather than adding one. */
    initial?: Partial<ColumnDraft>;
    submitLabel?: string;
    title?: string;
}

const TYPE_OPTIONS: Array<{ type: ColumnType; label: string }> = [
    { type: "text", label: "Text" },
    { type: "number", label: "Number" },
    { type: "date", label: "Date" },
    { type: "boolean", label: "Yes / no" },
    { type: "select", label: "Category" },
];

/**
 * The composer for a column that Beaver fills.
 *
 * A column here is a question, not a label — `Column.description` is the
 * extraction prompt — so the question gets the largest field and the plainest
 * explanation. The cost line is not decoration either: populating a column
 * bills per row, and that has to read as an approval before the run starts
 * rather than as a `+` button that quietly spends.
 */
export function AddColumnDialog({
    rowCount,
    costEstimate,
    onSubmit,
    onCancel,
    initial,
    submitLabel = "Extract column",
    title = "New column",
}: AddColumnDialogProps): React.ReactElement {
    const [header, setHeader] = useState(initial?.header ?? "");
    const [type, setType] = useState<ColumnType>(initial?.type ?? "text");
    const [description, setDescription] = useState(initial?.description ?? "");

    const ready = header.trim().length > 0 && description.trim().length > 0;

    return (
        <div className="bt-dialog" role="dialog" aria-label={title}>
            <div className="bt-dialog-title">{title}</div>

            <label className="bt-field">
                <span className="bt-field-label">Name</span>
                <input
                    className="bt-input"
                    type="text"
                    value={header}
                    placeholder="e.g. Sample size"
                    onChange={(e) => setHeader(e.target.value)}
                />
            </label>

            <div className="bt-field">
                <span className="bt-field-label">Type</span>
                <div className="bt-typerow">
                    {TYPE_OPTIONS.map((option) => (
                        <button
                            key={option.type}
                            type="button"
                            className={`bt-typebtn${type === option.type ? " bt-active" : ""}`}
                            aria-pressed={type === option.type}
                            onClick={() => setType(option.type)}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            <label className="bt-field">
                <span className="bt-field-label">Question</span>
                <textarea
                    className="bt-textarea"
                    value={description}
                    placeholder="What should Beaver look for in each item?"
                    onChange={(e) => setDescription(e.target.value)}
                />
                <span className="bt-field-hint">
                    Beaver runs this question against every item and cites the
                    sentence it answered from.
                </span>
            </label>

            <CostLine rowCount={rowCount} costEstimate={costEstimate} />

            <div className="bt-dialog-actions">
                <Button variant="surface" onClick={onCancel}>
                    Cancel
                </Button>
                <Button
                    variant="solid"
                    disabled={!ready}
                    onClick={() =>
                        onSubmit({
                            header: header.trim(),
                            type,
                            description: description.trim(),
                        })
                    }
                >
                    {submitLabel}
                </Button>
            </div>
        </div>
    );
}

function CostLine({
    rowCount,
    costEstimate,
}: {
    rowCount: number;
    costEstimate?: TableCostEstimate;
}): React.ReactElement {
    const credits = costEstimate
        ? Math.max(1, Math.round(costEstimate.per_row_credits * rowCount))
        : undefined;
    const seconds = costEstimate?.estimated_seconds;

    return (
        <div className="bt-costbox">
            <span className="bt-costicon" aria-hidden="true">
                <Icon icon={ClockIcon} size={15} />
            </span>
            <span>
                <span className="bt-costmain">
                    Runs on {rowCount} {rowCount === 1 ? "item" : "items"}
                    {credits != null
                        ? ` · about ${credits} credits`
                        : " · this uses credits"}
                </span>
                <span className="bt-costsub">
                    {seconds != null ? `Roughly ${seconds} seconds. ` : ""}
                    {credits == null
                        ? "The exact cost is not available here. "
                        : ""}
                    Nothing is charged until you start.
                </span>
            </span>
        </div>
    );
}

export default AddColumnDialog;
