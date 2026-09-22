import React from "react";
import type { DuplicatesResultView as View } from "@beaver/agent-core/protocol/duplicates";
import { getHost } from "@beaver/agent-ui/host";

export function duplicateFieldText(value: unknown): string {
    if (value == null || value === "") return "—";
    if (typeof value === "string") return value;
    if (Array.isArray(value))
        return value
            .map((v) =>
                typeof v === "object" && v
                    ? [v.firstName, v.lastName || v.name]
                          .filter(Boolean)
                          .join(" ")
                    : String(v),
            )
            .join("; ");
    return JSON.stringify(value);
}
export const DuplicatesResultView: React.FC<{ view: View }> = ({ view }) => (
    <div
        className="p-3 text-sm display-flex flex-col gap-3"
        data-testid="duplicates-result"
    >
        {!view.groups.length && (
            <div className="font-color-secondary">
                No duplicate candidates found.
            </div>
        )}
        {view.groups.map((group) => (
            <section
                key={group.group_id}
                className="border-card rounded-card p-2"
            >
                <div className="font-medium mb-2">
                    {group.members.length} candidate records
                </div>
                {group.members.map((member) => (
                    <div key={member.item_id} className="mb-2">
                        <button
                            type="button"
                            className="text-left font-color-primary"
                            style={{
                                background: "none",
                                border: 0,
                                padding: 0,
                                cursor: "pointer",
                            }}
                            onClick={() =>
                                getHost().navigation?.revealInLibrary({
                                    library_id: 0,
                                    library_ref: member.library_ref,
                                    zotero_key: member.zotero_key,
                                })
                            }
                        >
                            {member.title}
                        </button>
                        <div className="text-xs font-color-secondary">
                            {[member.creators, member.date, member.item_type]
                                .filter(Boolean)
                                .join(" · ")}
                        </div>
                        <div className="text-xs font-color-secondary">
                            {member.attachment_count} attachments ·{" "}
                            {member.note_count} notes · {member.item_id}
                        </div>
                        {member.children?.map((child) => (
                            <div className="text-xs ml-3" key={child.item_id}>
                                {child.title || child.item_type}
                                {child.annotation_count
                                    ? ` · ${child.annotation_count} annotations`
                                    : ""}
                            </div>
                        ))}
                    </div>
                ))}
                {group.warnings.map((w) => (
                    <div
                        role="note"
                        className="text-xs font-color-secondary mb-1"
                        key={w}
                    >
                        {w}
                    </div>
                ))}
                {group.differing_fields.length > 0 && (
                    <details open={view.mode === "inspect"}>
                        <summary className="text-xs cursor-pointer">
                            {group.differing_fields.length} differing fields
                        </summary>
                        <div className="overflow-x-auto">
                            <table
                                className="text-xs"
                                style={{
                                    width: "100%",
                                    borderCollapse: "collapse",
                                }}
                            >
                                <thead>
                                    <tr>
                                        <th style={{ textAlign: "left" }}>
                                            Field
                                        </th>
                                        {group.members.map((m) => (
                                            <th
                                                key={m.item_id}
                                                style={{
                                                    textAlign: "left",
                                                    padding: 6,
                                                }}
                                            >
                                                {m.zotero_key}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {group.differing_fields.map((field) => (
                                        <tr key={field}>
                                            <th
                                                style={{
                                                    textAlign: "left",
                                                    verticalAlign: "top",
                                                }}
                                            >
                                                {field}
                                            </th>
                                            {group.members.map((m) => (
                                                <td
                                                    key={m.item_id}
                                                    style={{
                                                        padding: 6,
                                                        verticalAlign: "top",
                                                        whiteSpace: "pre-wrap",
                                                        overflowWrap:
                                                            "anywhere",
                                                    }}
                                                >
                                                    {duplicateFieldText(
                                                        m.fields[field],
                                                    )}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </details>
                )}
            </section>
        ))}
        {view.mode === "find" && (
            <div className="text-xs font-color-secondary">
                Showing {view.groups.length} of {view.total_count} candidate
                groups{view.has_more ? " · More groups available" : ""}
            </div>
        )}
    </div>
);
