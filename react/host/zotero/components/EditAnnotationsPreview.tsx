import React from "react";
import type { ActionStatus } from "./agentActionViewHelpers";

/** Human-readable summary of one edit group's patch and move. */
function describeEdit(group: Record<string, any>): string {
    const changes = group.changes ?? {};
    const parts: string[] = [];
    if (changes.color != null) parts.push(`color: ${changes.color}`);
    if (changes.comment != null)
        parts.push(changes.comment === "" ? "clear comment" : "replace comment");
    if (changes.add_tags?.length)
        parts.push(`add tags: ${changes.add_tags.join(", ")}`);
    if (changes.remove_tags?.length)
        parts.push(`remove tags: ${changes.remove_tags.join(", ")}`);
    if (group.relocation?.locator) parts.push(`move to ${group.relocation.locator}`);
    return parts.join(" · ");
}

function plural(count: number): string {
    return count === 1 ? "" : "s";
}

export const EditAnnotationsPreview: React.FC<{
    actionData: Record<string, any>;
    status: ActionStatus | "awaiting";
}> = ({ actionData }) => {
    const skipped: Array<{ annotation_id: string; reason: string }> =
        Array.isArray(actionData.skipped) ? actionData.skipped : [];
    const skippedRow = skipped.length ? (
        <div className="text-sm font-color-secondary">
            {skipped.length} annotation{plural(skipped.length)} skipped:{" "}
            {skipped[0].reason}
            {skipped.length > 1 ? ` (+${skipped.length - 1} more)` : ""}
        </div>
    ) : null;

    if ((actionData.operation ?? "edit") === "delete") {
        const count = Array.isArray(actionData.annotation_refs)
            ? actionData.annotation_refs.length
            : 0;
        return (
            <div className="display-flex flex-col gap-1 px-15 py-15">
                <div className="text-sm">
                    Delete {count} annotation{plural(count)}
                </div>
                <div className="text-sm font-color-secondary">
                    The annotations will be moved to the Zotero trash.
                </div>
                {skippedRow}
            </div>
        );
    }

    const edits: Array<Record<string, any>> = Array.isArray(actionData.edits)
        ? actionData.edits
        : [];
    const total = edits.reduce(
        (sum, group) => sum + (group.annotation_refs?.length ?? 0),
        0,
    );

    return (
        <div className="display-flex flex-col gap-1 px-15 py-15">
            <div className="text-sm">
                Edit {total} annotation{plural(total)}
            </div>
            {/* One row per group so a heterogeneous batch stays reviewable —
                the user can see what each subset actually receives. */}
            {edits.map((group, index) => {
                const count = group.annotation_refs?.length ?? 0;
                return (
                    <div key={index} className="text-sm font-color-secondary">
                        {edits.length > 1 ? `${count} annotation${plural(count)}: ` : ""}
                        {describeEdit(group)}
                    </div>
                );
            })}
            {skippedRow}
        </div>
    );
};
