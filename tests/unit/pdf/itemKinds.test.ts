import { describe, expect, it } from "vitest";

import { ID_PREFIXES, type DocumentItemKind } from "@beaver/agent-core/extract/schema";
import {
    ITEM_KINDS,
    carriesSentences,
    kindCarriesSentences,
} from "../../../src/beaver-extract/schema/itemKinds";
import { projectStructuredPage } from "../../../src/beaver-extract/schema/canonicalProjection";
import { assignDocumentIds } from "../../../src/beaver-extract/schema/ids";
import type { DocItem } from "@beaver/agent-core/extract/types";

const kinds = Object.keys(ITEM_KINDS) as DocumentItemKind[];

describe("item kind policy", () => {
    it("splits text, list items, captions, footnotes and tables into sentences", () => {
        expect(kinds.filter(kindCarriesSentences).sort()).toEqual(
            ["caption", "footnote", "list_item", "table", "text"],
        );
    });

    it("publishes every kind except margin items", () => {
        expect(kinds.filter((kind) => !ITEM_KINDS[kind].citable)).toEqual(["margin"]);
    });

    it("takes every id prefix from ID_PREFIXES", () => {
        for (const kind of kinds) expect(ITEM_KINDS[kind].idPrefix).toBe(ID_PREFIXES[kind]);
    });

    it("lets only pictures omit their text", () => {
        expect(kinds.filter((kind) => !ITEM_KINDS[kind].hasText)).toEqual(["picture"]);
    });

    it("projects sentences only for sentence-bearing kinds and numbers ids by kind prefix", () => {
        const item = (kind: "text" | "reference" | "caption", index: number): DocItem => ({
            id: `p0:i${index}`,
            pageIndex: 0,
            index,
            bbox: { l: 0, t: index * 10, r: 10, b: index * 10 + 5, origin: "top-left" },
            columnIndex: 0,
            text: `${kind} ${index}`,
            lines: [],
            kind,
        }) as DocItem;
        const items = [item("text", 0), item("reference", 1), item("caption", 2)];
        const sentence = (parentId: string) => ({
            parentId,
            index: 0,
            text: "One.",
            bboxes: [{ l: 0, t: 0, r: 1, b: 1, origin: "top-left" as const }],
        });
        const page = projectStructuredPage({
            index: 0,
            width: 100,
            height: 100,
            viewBox: [0, 0, 100, 100],
            rotation: 0,
            items,
            sentences: items.map((i) => sentence(i.id)),
        });
        assignDocumentIds([page], "page");
        expect(page.items.map((i) => [i.id, "sentences" in i ? i.sentences?.length : undefined])).toEqual([
            ["p1.1", 1],
            ["ref1.1", undefined],
            ["caption1.1", 1],
        ]);
        expect(items.map(carriesSentences)).toEqual([true, false, true]);
    });
});
