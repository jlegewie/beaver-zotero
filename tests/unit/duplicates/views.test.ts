import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../react/host/zotero/agentActionExecution", async () => {
    const { atom } = await import("jotai");
    return { inFlightAgentActionIdsAtom: atom(new Set<string>()) };
});
import {
    MergeItemsPreview,
    fieldOptions,
    mergeFieldPlan,
} from "../../../react/host/zotero/components/MergeItemsPreview";
import { DuplicatesResultView } from "../../../react/components/agentRuns/toolResultViews/DuplicatesResultView";
import {
    groupFieldValues,
    groupMemberLines,
} from "../../../react/components/agentRuns/toolResultViews/duplicateDisplay";
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
it("renders groups from persisted view data without live item reads", () => {
    const html = renderToStaticMarkup(
        React.createElement(DuplicatesResultView, {
            view: {
                view_type: "duplicates",
                mode: "find",
                groups: [group],
                total_count: 12,
                has_more: true,
                next_offset: 1,
                snapshot_id: "",
            },
        }),
    );
    expect(html).toContain("Duplicate paper");
    expect(html).toContain("A. Author · 2025");
    expect(html).toContain("1 attachment · 1 note");
    expect(html).toContain("Differs in Abstract");
    expect(html).toContain("Showing groups 1–1 of 12");
    // Portable ids are for the model, not the reader.
    expect(html).not.toContain("u-AAAA1111");
});

it("shows each differing field's merged value, with alternatives closed", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "fields",
            editable: true,
            data: {
                master_item_id: members[0].item_id,
                other_item_ids: [members[1].item_id],
                preview: group,
            },
        }),
    );
    expect(html).toContain("Merged metadata");
    expect(html).toContain("Abstract");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/name="merge-field-/);
    // The kept record has no abstract, so that is what the merged record gets.
    expect(html).toContain(">Empty<");
    expect(html).not.toContain("Full abstract");
    // Identical bylines don't tell records apart; date added does.
    expect(html).not.toContain("A. Author · 2025");
    expect(html).toContain("Added Jan 1, 2025");
    expect(html).toContain("To Trash");
});

it("shows a value taken from another record as the merged value, without naming its source", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "picked",
            editable: true,
            data: {
                master_item_id: members[0].item_id,
                other_item_ids: [members[1].item_id],
                field_sources: { abstractNote: members[1].item_id },
                preview: group,
            },
        }),
    );
    expect(html).toContain("Full abstract");
    expect(html).not.toMatch(/from [AB]\b/);
});

it("ends with one generic note on what the merge combines", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "note",
            editable: true,
            data: {
                master_item_id: members[0].item_id,
                other_item_ids: [members[1].item_id],
                preview: group,
            },
        }),
    );
    expect(html).toContain(
        "Notes, attachments, tags and collections from all records are combined into the kept record.",
    );
});

describe("mergeFieldPlan", () => {
    const withFields = (fields: Record<string, unknown>[], differing: string[]) => ({
        ...group,
        members: members.map((m, i) => ({ ...m, fields: fields[i] })),
        differing_fields: differing,
    });
    const atMaster = () => 0;

    it("follows Zotero: no bookkeeping dates and no empty alternatives", () => {
        const g = withFields(
            [
                { title: "Paper", publisher: "Wiley", accessDate: "2025-07-14T22:08:23Z", url: "" },
                { title: "Paper (preprint)", publisher: "", accessDate: "2025-07-05T22:34:15Z", url: "https://x" },
            ],
            ["title", "publisher", "accessDate", "url"],
        );
        expect(mergeFieldPlan(g, 0, atMaster)).toEqual({ listed: ["title", "url"], picks: [] });
    });

    it("offers an empty master value alongside the non-empty alternative", () => {
        const g = withFields([{ url: "" }, { url: "https://x" }], ["url"]);
        expect(fieldOptions(g, "url", 0, 0).map((o) => o.text)).toEqual([null, "https://x"]);
        expect(fieldOptions(g, "url", 1, 1).map((o) => o.text)).toEqual(["https://x"]);
    });

    it("keeps the kept record's empty value available after picking another value", () => {
        const g = withFields([{ url: "" }, { url: "https://x" }], ["url"]);
        const options = fieldOptions(g, "url", 1, 0);
        expect(options.map((o) => o.text)).toEqual([null, "https://x"]);
        expect(options[0].indices).toEqual([0]);
        expect(mergeFieldPlan(g, 0, () => 1)).toEqual({ listed: ["url"], picks: ["url"] });
    });

    it("keeps creators that differ only in role as separate choices", () => {
        const king = { firstName: "Gary", lastName: "King" };
        const g = withFields(
            [
                { creators: [{ ...king, creatorType: "author" }] },
                { creators: [{ ...king, creatorType: "editor" }] },
            ],
            ["creators"],
        );
        const options = fieldOptions(g, "creators", 0, 0);
        expect(options.map((o) => o.text)).toEqual(["Gary King", "Gary King (Editor)"]);
        expect(mergeFieldPlan(g, 0, atMaster).listed).toEqual(["creators"]);
    });

    it("treats every empty form of a value as the same value", () => {
        const g = withFields([{ url: "" }, { url: undefined }], ["url"]);
        expect(fieldOptions(g, "url", 0, 0)).toHaveLength(1);
        expect(fieldOptions(g, "url", 0, 0)[0].indices).toEqual([0, 1]);
    });

    it("lists a picked field even when Zotero's rules would hide it", () => {
        const g = withFields(
            [{ accessDate: "2025-07-14T22:08:23Z" }, { accessDate: "2025-07-05T22:34:15Z" }],
            ["accessDate"],
        );
        expect(mergeFieldPlan(g, 0, () => 1)).toEqual({ listed: ["accessDate"], picks: ["accessDate"] });
    });
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
    expect(html).toContain("Keeps the record added Jan 1, 2025");
    expect(html).toContain("The other record moves to the Trash");
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
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.includes('disabled=""'))).toBe(true);
    expect(html).not.toContain("<select");
});

it("words the compact summary in the past tense once applied", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "applied",
            compact: true,
            editable: false,
            data: {
                master_item_id: members[0].item_id,
                other_item_ids: [members[1].item_id],
                field_sources: { abstractNote: members[1].item_id },
                preview: group,
            },
            result: {
                master_item_id: members[0].item_id,
                merged_item_ids: [members[1].item_id],
                preview: group,
                changes: [],
            },
        }),
    );
    expect(html).toContain("Kept the record added Jan 1, 2025");
    expect(html).toContain("The other record moved to the Trash · Abstract from another record");
});

it("names each record's item type when a group mixes types", () => {
    const mixed = {
        ...group,
        members: [members[0], { ...members[1], item_type: "book" }],
    };
    const html = renderToStaticMarkup(
        React.createElement(DuplicatesResultView, {
            view: {
                view_type: "duplicates",
                mode: "find",
                groups: [mixed],
                total_count: 1,
                has_more: false,
                next_offset: null,
                snapshot_id: "",
            },
        }),
    );
    expect(html).toContain("Journal Article · A. Author · 2025");
    expect(html).toContain("Book · A. Author · 2025");
});

it("does not report bookkeeping dates as differences in find results", () => {
    const html = renderToStaticMarkup(
        React.createElement(DuplicatesResultView, {
            view: {
                view_type: "duplicates",
                mode: "find",
                groups: [{ ...group, differing_fields: ["accessDate", "dateModified"] }],
                total_count: 1,
                has_more: false,
                next_offset: null,
                snapshot_id: "",
            },
        }),
    );
    expect(html).not.toContain("Differs in");
    expect(html).not.toContain("differences:");
});

it("groups find-result comparisons by underlying value, naming creator roles", () => {
    const king = { firstName: "Gary", lastName: "King" };
    const rows = groupFieldValues(
        {
            ...group,
            members: [
                { ...members[0], fields: { creators: [{ ...king, creatorType: "author" }] } },
                { ...members[1], fields: { creators: [{ ...king, creatorType: "editor" }] } },
            ],
            differing_fields: ["creators"],
        },
        "creators",
    );
    expect(rows.map((r) => [r.indices, r.text])).toEqual([
        [[0], "Gary King"],
        [[1], "Gary King (Editor)"],
    ]);
});

describe("groupMemberLines", () => {
    const sameDay = (overrides: Partial<(typeof members)[number]>[]) => ({
        ...group,
        members: members.map((m, i) => ({ ...m, ...overrides[i] })),
    });
    const labels = (g: typeof group) =>
        groupMemberLines(g).map((l) => `${l.primary}|${l.secondary ?? ""}`);

    it("keeps the plain labels when they already differ", () => {
        const g = sameDay([{ date_added: "2025-01-01" }, { date_added: "2025-02-01" }]);
        expect(groupMemberLines(g)).toEqual([
            { primary: "Added Jan 1, 2025", secondary: "1 attachment · 1 note" },
            { primary: "Added Feb 1, 2025", secondary: "1 attachment · 1 note" },
        ]);
    });

    it("adds the time of day when same-day records otherwise read alike", () => {
        const g = sameDay([
            { date_added: "2025-01-01 09:00:00" },
            { date_added: "2025-01-01 15:30:00" },
        ]);
        const lines = labels(g);
        expect(new Set(lines).size).toBe(2);
        expect(lines.every((l) => /\d{1,2}:\d{2}/.test(l))).toBe(true);
        expect(lines.join()).not.toContain("AAAA1111");
    });

    it("leads with the title when same-time records have different titles", () => {
        const g = sameDay([
            { date_added: "2025-01-01 09:00:00", title: "Duplicate paper" },
            { date_added: "2025-01-01 09:00:00", title: "Duplicate paper: a reply" },
        ]);
        const lines = groupMemberLines(g);
        expect(lines.map((l) => l.primary)).toEqual(["Duplicate paper", "Duplicate paper: a reply"]);
        expect(lines[0].secondary).toContain("1 attachment · 1 note");
    });

    it("falls back to the item key when nothing else tells records apart", () => {
        const lines = labels(group);
        expect(new Set(lines).size).toBe(2);
        expect(lines[0]).toContain("AAAA1111");
        expect(lines[1]).toContain("BBBB2222");
    });

    it("keeps merge radios distinguishable for indistinct records", () => {
        const html = renderToStaticMarkup(
            React.createElement(MergeItemsPreview, {
                actionId: "indistinct",
                editable: true,
                data: {
                    master_item_id: members[0].item_id,
                    other_item_ids: [members[1].item_id],
                    preview: group,
                },
            }),
        );
        const radios = [...html.matchAll(/aria-label="(Keep the record [^"]+)"/g)].map((m) => m[1]);
        expect(radios).toHaveLength(2);
        expect(new Set(radios).size).toBe(2);
    });

    it("names merge radios by their contents when only the contents differ", () => {
        const g = { ...group, members: [members[0], { ...members[1], attachment_count: 2 }] };
        const html = renderToStaticMarkup(
            React.createElement(MergeItemsPreview, {
                actionId: "contents",
                editable: true,
                data: {
                    master_item_id: members[0].item_id,
                    other_item_ids: [members[1].item_id],
                    preview: g,
                },
            }),
        );
        const radios = [...html.matchAll(/aria-label="(Keep the record [^"]+)"/g)].map((m) => m[1]);
        expect(radios).toEqual([
            "Keep the record Added Jan 1, 2025, 1 attachment · 1 note",
            "Keep the record Added Jan 1, 2025, 2 attachments · 1 note",
        ]);
    });
});
