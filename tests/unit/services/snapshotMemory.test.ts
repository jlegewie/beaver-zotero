// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { measureSectionSourceText } from "../../../src/services/documentExtraction/dom/diagnostics";
import { visibleTextContent } from "../../../src/services/documentExtraction/dom/domWalk";

function docWith(bodyHtml: string): Document {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.body.innerHTML = bodyHtml;
    return doc;
}

describe("measureSectionSourceText — non-cloning coverage measurement", () => {
    // The measurement should match visibleTextContent(body).length.
    const cases = [
        "<p>Hello world</p>",
        "<div>intro <b>bold</b> outro</div>",
        "<p>ab</p><script>var x = 1 | 2;</script><p>cd</p>",
        "<style>.a{color:red}</style><div>visible only</div>",
        "<div>  spaced   out  text  </div>",
        "",
    ];

    it.each(cases)("matches visibleTextContent(body).length for %j", (html) => {
        const doc = docWith(html);
        expect(measureSectionSourceText(doc)).toBe(visibleTextContent(doc.body).length);
    });

    it("excludes script/style text from the count", () => {
        const doc = docWith("<p>ab</p><script>ignored_script_text()</script>");
        expect(measureSectionSourceText(doc)).toBe(2); // only "ab"
    });
});
