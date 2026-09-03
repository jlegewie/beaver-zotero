import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { TableSpec } from "@beaver/agent-core/layouts/table";
import {
    showTableInWindowAtom,
    showThreadInWindowAtom,
    windowSurfaceAtom,
} from "../../../react/atoms/windowSurface";

const table: TableSpec = {
    id: "draft",
    columns: [{ id: "ref", header: "Item", type: "reference" }],
    rows: [],
};

describe("showTableInWindowAtom", () => {
    it("gives every showing its own id, even for tables that share a render id", () => {
        const store = createStore();
        const first = store.set(showTableInWindowAtom, {
            variant: "search",
            table,
        });
        const second = store.set(showTableInWindowAtom, {
            variant: "search",
            table: { ...table, rows: [{ id: "r", cells: {} }] },
        });
        expect(first.kind).toBe("table");
        expect(first.id).not.toBe(second.id);
        expect(store.get(windowSurfaceAtom)).toEqual(second);
    });

    it("hands the window back to the thread", () => {
        const store = createStore();
        store.set(showTableInWindowAtom, { variant: "extraction", table });
        store.set(showThreadInWindowAtom);
        expect(store.get(windowSurfaceAtom)).toEqual({ kind: "thread" });
    });
});
