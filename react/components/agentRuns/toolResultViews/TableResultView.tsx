import React, { useState } from "react";
import type { TableView } from "@beaver/agent-core/run-state/toolResultViews";
import { getHost } from "@beaver/agent-ui/host";
import { useTableDisplay } from "../../../hooks/useTableDisplay";

/** Historical observations stay separate from the current local document. */
export function TableResultView({ view }: { view: TableView }) {
    const { record } = view;
    const current = useTableDisplay(record.reference.key);
    const [message, setMessage] = useState("");
    const open = async () => {
        const outcome = await getHost()
            .navigation?.openTable?.(record.reference.key)
            .catch(() => ({ error: "Table provider unavailable." }));
        setMessage(
            !outcome
                ? "Table provider unavailable."
                : "error" in outcome
                  ? outcome.error
                  : (outcome.warning ?? ""),
        );
    };
    return (
        <div className="p-3 text-sm display-flex flex-col gap-2">
            <strong>{record.reference.title || "Untitled table"}</strong>
            <div>{record.change}</div>
            {typeof record.summary.rows === "number" && (
                <div>
                    {record.summary.rows} rows · {record.summary.columns}{" "}
                    columns at this step
                </div>
            )}
            {record.saved === false && (
                <div role="status">
                    Changes are committed. Local bookkeeping needs repair; use
                    Check / repair table in the item pane.
                </div>
            )}
            {current?.status === "available" && (
                <div className="font-color-secondary">
                    Current: {current.title} · {current.rows} rows ·{" "}
                    {current.columns} columns
                </div>
            )}
            {current?.status === "unavailable" && (
                <div role="status">{current.reason}</div>
            )}
            <button type="button" className="variant-outline" onClick={open}>
                Open table
            </button>
            {message && <div role="status">{message}</div>}
            <div className="font-color-secondary">
                Retrying chat leaves this table intact. Restore retained
                versions from its item pane.
            </div>
        </div>
    );
}
