import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    messageAttachmentIdentity,
    mergeMessageAttachments,
    messageAttachmentsHaveSameIdentity,
    type TableAttachment,
} from "@beaver/agent-core/types/attachments/apiTypes";
import {
    isToolResultView,
    tableResultMessages,
} from "@beaver/agent-core/run-state/toolResultViews";
import { isTableChatEnabled } from "../../../src/services/tableCapability";
import { ZOTERO_PLUGIN_FEATURES } from "@beaver/agent-core/protocol/agentProtocol";

const attachment: TableAttachment = {
    type: "table",
    reference: { kind: "table", key: "u-ABCDEFGH", title: "Observed title" },
};

describe("table conversation contracts", () => {
    beforeEach(() => vi.clearAllMocks());
    it("keeps portable identities and historical observations while deduplicating attachments", () => {
        expect(messageAttachmentIdentity(attachment)).toBe("item:u-ABCDEFGH");
        const renamed = {
            ...attachment,
            reference: { ...attachment.reference, title: "New title" },
        };
        expect(mergeMessageAttachments([attachment], [renamed])).toEqual([
            attachment,
        ]);
        expect(messageAttachmentsHaveSameIdentity(attachment, renamed)).toBe(
            true,
        );
        expect(
            messageAttachmentsHaveSameIdentity(attachment, {
                type: "collection",
                library_id: 1,
                library_ref: "u",
                zotero_key: "ABCDEFGH",
                name: "Same key",
                parent_key: null,
            }),
        ).toBe(false);
        expect(mergeMessageAttachments([], [renamed])).toEqual([renamed]);
        expect(attachment.reference.title).toBe("Observed title");
    });
    it("recognizes compact cards without a result body and rejects malformed references", () => {
        const view = {
            view_type: "table",
            record: {
                reference: attachment.reference,
                summary: {},
                change: "Created table",
            },
        };
        expect(isToolResultView(view)).toBe(true);
        expect(isToolResultView({ ...view, record: null })).toBe(false);
        expect(
            isToolResultView({
                ...view,
                record: {
                    ...view.record,
                    reference: { ...attachment.reference, key: "../bad" },
                },
            }),
        ).toBe(false);
    });
    it.each(["production", "test", undefined])(
        "keeps table activation off in %s",
        (env) => {
            vi.stubGlobal("Zotero", { Beaver: { data: { env } } });
            expect(isTableChatEnabled()).toBe(false);
            expect(ZOTERO_PLUGIN_FEATURES).not.toContain("tables");
        },
    );
    it("allows development opt-in", () => {
        vi.stubGlobal("Zotero", { Beaver: { data: { env: "development" } } });
        expect(isTableChatEnabled()).toBe(true);
    });
    it("distinguishes unknown commits from confirmed uncommitted answers", () => {
        expect(
            tableResultMessages({ error_code: "outcome_unknown" }).join(" "),
        ).toContain("may have completed");
        expect(
            tableResultMessages({ error_code: "confirmed_uncommitted" }).join(
                " ",
            ),
        ).toContain("were not saved");
        expect(
            tableResultMessages({ error_code: "schema_changed" }).join(" "),
        ).toContain("review its approval");
        expect(
            tableResultMessages({ error_code: "provider_offline" }).join(" "),
        ).toContain("provider unavailable");
        expect(tableResultMessages({ status: "partial" }).join(" ")).toContain(
            "Earlier committed answers remain",
        );
    });
    it("keeps committed work successful despite bookkeeping or result-recording failures", () => {
        const result = {
            ok: true,
            saved: false,
            recording_warning: "failed",
            rejected_count: 2,
        };
        const messages = tableResultMessages(JSON.stringify(result));
        // Bookkeeping that failed after the commit is repaired when the table
        // opens; it is not a chat status.
        expect(messages.join(" ")).not.toContain("bookkeeping");
        expect(messages.join(" ")).toContain(
            "confirmed table outcome is unchanged",
        );
        expect(messages.join(" ")).toContain("2 row changes were rejected");
        expect(result.ok).toBe(true);
    });
    it("does not imply a table exists when every proposed row was rejected", () => {
        const messages = tableResultMessages({
            ok: false,
            error_code: "no_valid_rows",
            rejected: [{ row: "a" }, { row: "b" }],
        }).join(" ");
        expect(messages).toContain("2 row changes were rejected.");
        expect(messages).not.toContain("remain in the table");
    });
});
