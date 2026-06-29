// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    getDeclaredCharset,
    isLikelyNonUtf8Charset,
} from "../../../src/services/documentExtraction/snapshot/snapshotDom";

function docWithHead(headHtml: string): Document {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.head.innerHTML = headHtml;
    return doc;
}

describe("getDeclaredCharset", () => {
    it("reads a <meta charset> declaration, lowercased", () => {
        expect(getDeclaredCharset(docWithHead('<meta charset="UTF-8">'))).toBe("utf-8");
        expect(getDeclaredCharset(docWithHead('<meta charset="windows-1252">'))).toBe("windows-1252");
    });

    it("reads a legacy http-equiv content-type charset", () => {
        const doc = docWithHead('<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">');
        expect(getDeclaredCharset(doc)).toBe("iso-8859-1");
    });

    it("returns null when no charset is declared", () => {
        expect(getDeclaredCharset(docWithHead("<title>x</title>"))).toBeNull();
    });
});

describe("isLikelyNonUtf8Charset", () => {
    it("treats UTF-8 / ASCII labels and a missing declaration as UTF-8 compatible", () => {
        expect(isLikelyNonUtf8Charset(null)).toBe(false);
        expect(isLikelyNonUtf8Charset("utf-8")).toBe(false);
        expect(isLikelyNonUtf8Charset("utf8")).toBe(false);
        expect(isLikelyNonUtf8Charset("us-ascii")).toBe(false);
    });

    it("flags legacy single-byte and CJK encodings", () => {
        expect(isLikelyNonUtf8Charset("windows-1252")).toBe(true);
        expect(isLikelyNonUtf8Charset("iso-8859-1")).toBe(true);
        expect(isLikelyNonUtf8Charset("shift_jis")).toBe(true);
        expect(isLikelyNonUtf8Charset("gb2312")).toBe(true);
    });
});
