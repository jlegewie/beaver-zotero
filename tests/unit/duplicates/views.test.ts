import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("../../../react/host/zotero/agentActionExecution", async () => {
    const { atom } = await import("jotai");
    return { inFlightAgentActionIdsAtom: atom(new Set<string>()) };
});
import { MergeItemsPreview } from "../../../react/host/zotero/components/MergeItemsPreview";
import { DuplicatesResultView } from "../../../react/components/agentRuns/toolResultViews/DuplicatesResultView";
const members = ["AAAA1111", "BBBB2222"].map((key, n) => ({
    item_id: `u-${key}`,
    library_ref: "u",
    zotero_key: key,
    title: "Duplicate paper",
    item_type: "journalArticle",
    creators: "A. Author",
    date: "2025",
    doi: "",
    isbn: "",
    date_added: "2025-01-01",
    attachment_count: 1,
    note_count: 1,
    fields: { abstractNote: n ? "Full abstract" : "" },
    children: [
        {
            item_id: `u-NOTE000${n}`,
            title: "Research note",
            item_type: "note",
            annotation_count: 0,
        },
    ],
}));
const group = {
    group_id: "group",
    members,
    differing_fields: ["abstractNote"],
    warnings: [],
    mergeable: true,
    recommended_master_item_id: members[0].item_id,
};
it("renders independent master controls when the same action appears twice", () => {
    const props = {
        actionId: "same-action",
        editable: true,
        data: {
            master_item_id: members[0].item_id,
            other_item_ids: [members[1].item_id],
            preview: group,
        },
    };
    const html = renderToStaticMarkup(
        React.createElement(
            React.Fragment,
            null,
            React.createElement(MergeItemsPreview, props),
            React.createElement(MergeItemsPreview, props),
        ),
    );
    const names = [...html.matchAll(/name="(merge-master-[^"]+)"/g)].map(
        (m) => m[1],
    );
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(2);
});
it("renders comparison values and children from persisted view data without live item reads", () => {
    const html = renderToStaticMarkup(
        React.createElement(DuplicatesResultView, {
            view: {
                view_type: "duplicates",
                mode: "find",
                groups: [group],
                total_count: 1,
                has_more: false,
                next_offset: null,
                snapshot_id: "",
            },
        }),
    );
    expect(html).toContain("Full abstract");
    expect(html).toContain("Research note");
    expect(html).toContain("BBBB2222");
});

it("renders a compact read-only summary in Changes", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "review",
            compact: true,
            editable: true,
            data: {
                master_item_id: members[0].item_id,
                other_item_ids: [members[1].item_id],
                preview: group,
            },
        }),
    );
    expect(html).toContain("merge-items-summary");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
});
it("disables all merge controls while applying", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "busy",
            editable: false,
            data: {
                master_item_id: members[0].item_id,
                other_item_ids: [members[1].item_id],
                preview: group,
            },
        }),
    );
    expect([...html.matchAll(/<input[^>]*disabled=""/g)]).toHaveLength(2);
    expect(html).not.toContain("<select");
});
