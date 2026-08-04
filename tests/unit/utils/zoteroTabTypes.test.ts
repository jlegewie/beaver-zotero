import { describe, expect, it } from "vitest";
import { isActiveReaderTabType } from "../../../react/utils/zoteroTabTypes";

describe("isActiveReaderTabType", () => {
    it.each(["reader", "reader-loading"])(
        "recognizes the active reader lifecycle state %s",
        (type) => {
            expect(isActiveReaderTabType(type)).toBe(true);
        },
    );

    it.each(["reader-unloaded", "library", "note", "note-loading"])(
        "rejects non-active-reader state %s",
        (type) => {
            expect(isActiveReaderTabType(type)).toBe(false);
        },
    );
});
