// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    buildAnnotationFromDocument,
    parseOpfSpine,
    resolveTargetItemref,
    sanitizeSectionDocument,
} from "../../../src/services/annotations/epub/epubAnnotationResolver";

function parse(xml: string, type: DOMParserSupportedType): Document {
    return new DOMParser().parseFromString(xml, type);
}

// A spine with a non-XHTML item (image) in the middle, so the extractor's
// compacted ordinal drifts below the raw spine index.
const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata/>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
    <item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="pic"/>
    <itemref idref="c1" id="ref-c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const ALL_ENTRIES_PRESENT = () => true;

describe("parseOpfSpine", () => {
    it("reads the raw spine order and spine node index", () => {
        const doc = parse(OPF, "text/xml");
        const spine = parseOpfSpine(doc, "OEBPS/content.opf", ALL_ENTRIES_PRESENT);

        // package children: metadata(0), manifest(1), spine(2)
        expect(spine.spineNodeIndex).toBe(2);
        expect(spine.itemrefs.map((r) => r.idref)).toEqual(["cover", "pic", "c1", "c2"]);
        // Hrefs resolved relative to the OPF directory.
        expect(spine.itemrefs[2].href).toBe("OEBPS/text/chapter1.xhtml");
        expect(spine.itemrefs[2].id).toBe("ref-c1");
        expect(spine.itemrefs[1].isXhtml).toBe(false); // the image
        expect(spine.itemrefs[2].isXhtml).toBe(true);
    });
});

describe("resolveTargetItemref", () => {
    const spine = parseOpfSpine(parse(OPF, "text/xml"), "OEBPS/content.opf", ALL_ENTRIES_PRESENT);

    it("matches by href basename to the raw spine index", () => {
        const match = resolveTargetItemref(spine, { sectionHref: "text/chapter1.xhtml" });
        expect(match?.rawIndex).toBe(2);
    });

    it("maps a compacted ordinal to the raw spine index, skipping non-XHTML items", () => {
        // Compacted ordinal 2 = the 2nd XHTML section (chapter1), whose RAW spine
        // index is 2 because the image itemref at raw index 1 is skipped.
        const match = resolveTargetItemref(spine, { sectionOrdinal: 2 });
        expect(match?.rawIndex).toBe(2);
        expect(match?.itemref.idref).toBe("c1");
    });

    it("returns null when nothing matches", () => {
        expect(resolveTargetItemref(spine, { sectionHref: "missing.xhtml" })).toBeNull();
    });
});

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function section(bodyInner: string, headInner = "<title>T</title>"): Document {
    return parse(
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<html xmlns="${XHTML_NS}"><head>${headInner}</head><body>${bodyInner}</body></html>`,
        "application/xhtml+xml",
    );
}

describe("sanitizeSectionDocument", () => {
    it("removes body-level style/link so element indices match the reader", () => {
        const doc = section(
            `<style>.x{}</style><link rel="stylesheet" href="a.css"/><p>Target sentence here.</p>`,
        );
        // rawSectionIndex 2 -> base /6/6 ; spineNodeIndex 2.
        sanitizeSectionDocument(doc);

        const built = buildAnnotationFromDocument(doc, 2, 2, { text: "Target" });
        if ("error" in built) throw new Error(`unexpected error: ${built.error}`);
        // After sanitize the <p> is the only body child -> /2 (not /4).
        expect(built.position.value).toBe("epubcfi(/6/6!/4/2,/1:0,/1:6)");
    });
});

describe("buildAnnotationFromDocument", () => {
    it("builds a range CFI + EPUB sortIndex for a located sentence", () => {
        const doc = section("<p>First.</p><p>Second sentence here.</p>");
        // The orchestrator sanitizes before building; the sortIndex offset is
        // measured from the section root, so an unstripped <title> would inflate
        // it. Sanitize first to mirror the real pipeline.
        sanitizeSectionDocument(doc);
        const built = buildAnnotationFromDocument(doc, 2, 2, { text: "Second sentence" });
        if ("error" in built) throw new Error(`unexpected error: ${built.error}`);

        // body(/4) > 2nd p(/4) > text(/1); "Second sentence" = offsets 0..15.
        expect(built.position.value).toBe("epubcfi(/6/6!/4/4,/1:0,/1:15)");
        expect(built.position.conformsTo).toContain("epub-cfi");
        // sortIndex: section 2, offset = chars before the match ("First." = 6).
        expect(built.sortIndex).toMatch(/^\d{5}\|\d{8}$/);
        expect(built.sortIndex).toBe("00002|00000006");
        expect(built.text).toBe("Second sentence");
    });

    it("anchors note annotations to the cited text's containing block", () => {
        const doc = section("<p>First.</p><p>Second sentence here.</p>");
        sanitizeSectionDocument(doc);
        const built = buildAnnotationFromDocument(doc, 0, 2, {
            text: "Second sentence",
            anchorToBlock: true,
        });
        if ("error" in built) throw new Error(`unexpected error: ${built.error}`);
        // Range spans the 2nd <p> (the cited text's containing block, bounded by
        // its text nodes) so the reader renders the note icon in the margin
        // beside it, not inline over the start of the passage. body(/4) > 2nd
        // p(/4) > text(/1); the block's text "Second sentence here." is 21 chars.
        expect(built.position.value).toBe("epubcfi(/6/2!/4/4,/1:0,/1:21)");
        // sortIndex: section 0, offset = chars before the block ("First." = 6).
        expect(built.sortIndex).toBe("00000|00000006");
    });

    it("spans the whole block for a note even when inline markup splits the text", () => {
        const doc = section("<p>First.</p><p>Second <b>sentence</b> here.</p>");
        sanitizeSectionDocument(doc);
        const built = buildAnnotationFromDocument(doc, 0, 2, {
            text: "Second sentence",
            anchorToBlock: true,
        });
        if ("error" in built) throw new Error(`unexpected error: ${built.error}`);
        // The block range runs from the 2nd p's first text node ("Second ") to
        // its last (" here.") so the bbox still reaches the column margin.
        // body(/4) > 2nd p(/4); start text /1 offset 0, end text /3 (" here.").
        expect(built.position.value).toBe("epubcfi(/6/2!/4/4,/1:0,/3:6)");
    });

    it("falls back to the passage range for a note when no block ancestor exists", () => {
        // Loose text directly under <body> has no block-level container; the note
        // anchors to the passage range instead of failing.
        const doc = section("Loose cited text with no block.");
        sanitizeSectionDocument(doc);
        const built = buildAnnotationFromDocument(doc, 0, 2, {
            text: "cited text",
            anchorToBlock: true,
        });
        if ("error" in built) throw new Error(`unexpected error: ${built.error}`);
        // A range (two commas), not a collapsed point — the cited passage itself.
        expect(built.position.value).toMatch(/^epubcfi\(.+,.+,.+\)$/);
        expect(built.text).toBe("cited text");
    });

    it("fails observably when a MathML element precedes the range", () => {
        const doc = section(`<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></p><p>After the math.</p>`);
        const built = buildAnnotationFromDocument(doc, 2, 2, { text: "After the math" });
        expect("error" in built && built.error).toBe("epub_math_section_unsupported");
    });

    it("fails a block-anchored note when math sits inside the block after the cited text", () => {
        // The cited text precedes the math, but the note's block range extends to
        // the block's last text node — past the math. The guard must check that
        // end boundary, not the (math-free) start, or the persisted end path
        // diverges once the reader runs renderMath.
        const doc = section(
            `<p>Cited text <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math> trailing text.</p>`,
        );
        sanitizeSectionDocument(doc);
        const built = buildAnnotationFromDocument(doc, 0, 2, {
            text: "Cited text",
            anchorToBlock: true,
        });
        expect("error" in built && built.error).toBe("epub_math_section_unsupported");
    });

    it("returns epub_text_not_found when the passage is absent", () => {
        const doc = section("<p>Only this text.</p>");
        const built = buildAnnotationFromDocument(doc, 2, 2, { text: "nonexistent passage" });
        expect("error" in built && built.error).toBe("epub_text_not_found");
    });
});
