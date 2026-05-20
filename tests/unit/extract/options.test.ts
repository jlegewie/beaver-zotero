import { describe, expect, it } from "vitest";

import { parsePagesList } from "../../../src/beaver-extract/cli/options";

describe("parsePagesList", () => {
    it("preserves explicit caller order", () => {
        expect(parsePagesList("5,1,3")).toEqual([5, 1, 3]);
    });

    it("rejects duplicate page indices", () => {
        expect(() => parsePagesList("0,0,1")).toThrow(/duplicate page index/);
    });
});
