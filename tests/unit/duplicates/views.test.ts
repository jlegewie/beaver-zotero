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

describe("merge card after the merge or its undo fails", () => {
    const data = {
        master_item_id: members[0].item_id,
        other_item_ids: [members[1].item_id],
        preview: group,
    };
    const result = {
        master_item_id: members[0].item_id,
        merged_item_ids: [members[1].item_id],
        // The service describes the result with the kept record first.
        preview: { ...group, members: [members[0], members[1]] },
        changes: [],
    };
    const render = (props: Record<string, unknown>) =>
        renderToStaticMarkup(
            React.createElement(MergeItemsPreview, { actionId: "a", editable: false, data, ...props } as any),
        );

    it("shows a failed undo as still merged, with the reason", () => {
        const html = render({
            result,
            action: {
                id: "a",
                action_type: "merge_items",
                status: "error",
                result_data: result,
                error_message: "An affected tags changed after the merge. Undo was not applied.",
                error_details: { error_code: "undo_conflict" },
            },
        });
        expect(html).toContain("Kept record");
        expect(html).toContain("In Trash");
        expect(html).toContain("Undo not applied. Tags changed after the merge, and undo would overwrite that change.");
        expect(html).not.toContain("Undo was not applied");
    });

    it("explains a merge refused because the records changed since the proposal", () => {
        const html = render({
            action: {
                id: "a",
                action_type: "merge_items",
                status: "error",
                error_message: "Items changed since this merge was proposed. Inspect and propose the merge again.",
            },
        });
        expect(html).toContain("Record to keep");
        expect(html).toContain(
            "Not merged. The records changed after this merge was proposed. Ask Beaver to propose it again.",
        );
    });

    it("keeps the error in the compact Changes row", () => {
        const html = render({
            compact: true,
            result,
            action: {
                id: "a",
                action_type: "merge_items",
                status: "error",
                result_data: result,
                error_message: "An affected DOI changed after the merge. Undo was not applied.",
            },
        });
        expect(html).toContain("Kept the record");
        expect(html).toContain("Undo not applied. DOI changed after the merge");
    });

    it("shows no error line for a clean merge", () => {
        expect(render({ result, action: { id: "a", action_type: "merge_items", status: "applied" } })).not.toContain(
            'role="status"',
        );
    });
});

describe("applied merge card", () => {
    const dated = [
        { ...members[0], date_added: "2025-01-01", attachment_count: 0, note_count: 0, children: [] },
        { ...members[1], date_added: "2025-02-01", attachment_count: 1, note_count: 1 },
    ];
    const proposal = { ...group, members: dated };
    const render = (changes: unknown[]) =>
        renderToStaticMarkup(
            React.createElement(MergeItemsPreview, {
                actionId: "applied",
                editable: false,
                data: { master_item_id: dated[1].item_id, other_item_ids: [dated[0].item_id], preview: proposal },
                result: {
                    master_item_id: dated[1].item_id,
                    merged_item_ids: [dated[0].item_id],
                    preview: { ...proposal, members: [dated[1], dated[0]] },
                    changes,
                },
            } as any),
        );

    it("keeps the reviewed record order instead of listing the kept record first", () => {
        const html = render([]);
        expect(html.indexOf("Added Jan 1, 2025")).toBeLessThan(html.indexOf("Added Feb 1, 2025"));
    });

    it("credits the kept record with everything it now holds", () => {
        const g = { ...group, members: [members[0], members[1]] };
        const html = renderToStaticMarkup(
            React.createElement(MergeItemsPreview, {
                actionId: "totals",
                editable: false,
                data: { master_item_id: members[0].item_id, other_item_ids: [members[1].item_id], preview: g },
                result: {
                    master_item_id: members[0].item_id,
                    merged_item_ids: [members[1].item_id],
                    preview: g,
                    // Zotero consolidated the trashed record's identical PDF into the kept one.
                    changes: [
                        {
                            item_id: "u-PDF00002",
                            before: { itemType: "attachment", parentItem: "BBBB2222" },
                            after: { itemType: "attachment", parentItem: "BBBB2222", deleted: true },
                        },
                    ],
                },
            } as any),
        );
        expect(html).toContain("1 attachment · 2 notes");
        // Only the note moved; the PDF was a copy of the kept record's.
        expect(html).toContain(
            "Moved to the kept record: 1 note · 1 matching attachment consolidated into the kept record",
        );
        expect(html).not.toContain("Moved to the kept record: 1 attachment");
    });
});

it("tells same-time records apart by a differing field before falling back to the key", () => {
    const g = {
        ...group,
        differing_fields: ["url"],
        members: [
            { ...members[0], fields: { url: "https://journal.example/a" } },
            { ...members[1], fields: { url: "https://doi.example/b" } },
        ],
    };
    const lines = groupMemberLines(g).map((l) => `${l.primary}|${l.secondary}`);
    expect(lines[0]).toContain("URL: https://journal.example/a");
    expect(lines[1]).toContain("URL: https://doi.example/b");
    expect(lines.join()).not.toContain("AAAA1111");
});

it("keeps the detail that tells same-time records apart once the merge is applied", () => {
    const same = members.map((m, i) => ({
        ...m,
        date_added: "2026-10-01 13:24:00",
        attachment_count: 0,
        note_count: 0,
        children: [],
        fields: { url: i ? "https://doi.example/b" : "https://journal.example/a" },
    }));
    const g = { ...group, differing_fields: ["url"], members: same };
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "same-time",
            editable: false,
            data: { master_item_id: same[0].item_id, other_item_ids: [same[1].item_id], preview: g },
            result: { master_item_id: same[0].item_id, merged_item_ids: [same[1].item_id], preview: g, changes: [] },
        } as any),
    );
    expect(html).toContain("URL: https://journal.example/a");
    expect(html).toContain("URL: https://doi.example/b");
});

it("says only that an attachment was consolidated when nothing else moved", () => {
    const g = {
        ...group,
        members: [members[0], { ...members[1], note_count: 0, children: [] }],
    };
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "dedup",
            editable: false,
            data: { master_item_id: members[0].item_id, other_item_ids: [members[1].item_id], preview: g },
            result: {
                master_item_id: members[0].item_id,
                merged_item_ids: [members[1].item_id],
                preview: g,
                changes: [
                    {
                        item_id: "u-PDF00002",
                        before: { itemType: "attachment", parentItem: "BBBB2222" },
                        after: { itemType: "attachment", parentItem: "BBBB2222", deleted: true },
                    },
                ],
            },
        } as any),
    );
    expect(html).toContain("1 matching attachment consolidated into the kept record");
    expect(html).not.toContain("Moved to the kept record");
});

it("words a merge that failed to apply conditionally", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "stale",
            compact: true,
            editable: false,
            action: {
                id: "stale",
                action_type: "merge_items",
                status: "error",
                error_message: "Items changed since this merge was proposed. Inspect and propose the merge again.",
            },
            data: { master_item_id: members[0].item_id, other_item_ids: [members[1].item_id], preview: group },
        } as any),
    );
    expect(html).toContain("Would keep the record");
    expect(html).toContain("would move to the Trash");
    expect(html).not.toContain("Keeps the record");
});

it("falls back to the key when distinguishing values only differ past the shortened text", () => {
    const prefix = "https://journal.example/articles/2026/policing-schooling-";
    const g = {
        ...group,
        differing_fields: ["url"],
        members: [
            { ...members[0], fields: { url: `${prefix}a` } },
            { ...members[1], fields: { url: `${prefix}b` } },
        ],
    };
    const lines = groupMemberLines(g).map((l) => `${l.primary}|${l.secondary}`);
    expect(new Set(lines).size).toBe(2);
    expect(lines.join()).not.toContain("URL:");
    expect(lines[0]).toContain("AAAA1111");
});

it("counts notes the merge created on the kept record", () => {
    const html = renderToStaticMarkup(
        React.createElement(MergeItemsPreview, {
            actionId: "embedded-notes",
            editable: false,
            data: { master_item_id: members[0].item_id, other_item_ids: [members[1].item_id], preview: group },
            result: {
                master_item_id: members[0].item_id,
                merged_item_ids: [members[1].item_id],
                preview: group,
                changes: [
                    {
                        item_id: "u-PDF00002",
                        before: { itemType: "attachment", parentItem: "BBBB2222" },
                        after: { itemType: "attachment", parentItem: "BBBB2222", deleted: true },
                    },
                    // Both PDFs carried an embedded note, so Zotero made a new child note.
                    {
                        item_id: "u-NEWNOTE1",
                        before: null,
                        after: { itemType: "note", parentItem: "AAAA1111" },
                        created_by_merge: true,
                    },
                ],
            },
        } as any),
    );
    expect(html).toContain("1 attachment · 3 notes");
});

describe("annotations on consolidated attachments", () => {
    // B's only attachment matched one on the kept record A and was trashed.
    const withAttachment = (key: string) => [
        { ...members[0], attachment_count: 1, note_count: 0, children: [] },
        {
            ...members[1],
            attachment_count: 1,
            note_count: 0,
            children: [{ item_id: `u-${key}`, title: "Copy", item_type: "attachment", annotation_count: 2 }],
        },
    ];
    const render = (g: typeof group, changes: unknown[]) =>
        renderToStaticMarkup(
            React.createElement(MergeItemsPreview, {
                actionId: "annotations",
                editable: false,
                data: { master_item_id: g.members[0].item_id, other_item_ids: [g.members[1].item_id], preview: g },
                result: {
                    master_item_id: g.members[0].item_id,
                    merged_item_ids: [g.members[1].item_id],
                    preview: g,
                    changes,
                },
            } as any),
        );
    const trashed = (key: string) => ({
        item_id: `u-${key}`,
        before: { itemType: "attachment", parentItem: "BBBB2222" },
        after: { itemType: "attachment", parentItem: "BBBB2222", deleted: true },
    });

    it("leaves a web snapshot's annotations on the trashed copy", () => {
        // Zotero trashes a matching snapshot without moving its annotations.
        const g = { ...group, members: withAttachment("SNAP0002") };
        const html = render(g, [trashed("SNAP0002")]);
        expect(html).toContain(
            "1 matching attachment consolidated into the kept record · 2 annotations stayed on the trashed attachment",
        );
        expect(html).not.toContain("Moved to the kept record");
        // The kept record holds one attachment and none of the snapshot's annotations.
        expect(html).not.toContain("1 attachment · 2 annotations");
        expect(html).toContain(">1 attachment<");
    });

    it("credits a PDF's annotations to the kept record once Zotero moved them", () => {
        const g = { ...group, members: withAttachment("PDF00002") };
        const moved = (n: number) => ({
            item_id: `u-ANNO000${n}`,
            before: { itemType: "annotation", parentItem: "PDF00002" },
            after: { itemType: "annotation", parentItem: "PDF00001" },
        });
        const html = render(g, [trashed("PDF00002"), moved(1), moved(2)]);
        expect(html).toContain("1 attachment · 2 annotations");
        expect(html).toContain(
            "Moved to the kept record: 2 annotations · 1 matching attachment consolidated into the kept record",
        );
        expect(html).not.toContain("stayed on the trashed attachment");
    });
});
