// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    resolveEpubCitationRange,
    type EpubCitationTarget,
} from "../../../react/utils/epubVisualizer/epubRangeResolver";
import type {
    EpubPrimaryView,
    EpubSectionRenderer,
} from "../../../react/utils/epubVisualizer/epubReaderView";

interface FakeSection {
    href: string;
    html: string;
    mounted?: boolean;
}

interface FakeRenderer extends EpubSectionRenderer {
    mountCalls: number;
}

function makePrimaryView(sections: FakeSection[]): {
    primaryView: EpubPrimaryView;
    renderers: FakeRenderer[];
} {
    const renderers: FakeRenderer[] = sections.map((section, index) => {
        const container = document.createElement("div");
        container.innerHTML = section.html;
        const renderer: FakeRenderer = {
            mounted: section.mounted ?? true,
            body: container,
            container,
            section: { index, href: section.href },
            mountCalls: 0,
            mount() {
                renderer.mountCalls += 1;
                renderer.mounted = true;
            },
        };
        return renderer;
    });
    return {
        primaryView: { renderers } as unknown as EpubPrimaryView,
        renderers,
    };
}

function resolve(
    primaryView: EpubPrimaryView,
    target: EpubCitationTarget,
) {
    return resolveEpubCitationRange(primaryView, target);
}

describe("resolveEpubCitationRange", () => {
    describe("section resolution", () => {
        it("matches the section href by basename across path and hash differences", () => {
            const { primaryView } = makePrimaryView([
                { href: "intro.xhtml", html: "<p>Intro</p>" },
                { href: "text/chapter1.xhtml", html: "<p>Chapter one</p>" },
            ]);
            const resolved = resolve(primaryView, {
                sectionHref: "OEBPS/Text/Chapter1.xhtml#mid",
            });
            expect(resolved?.sectionIndex).toBe(1);
        });

        it("falls back to the 1-based section ordinal when the href does not match", () => {
            const { primaryView } = makePrimaryView([
                { href: "intro.xhtml", html: "<p>Intro</p>" },
                { href: "chapter1.xhtml", html: "<p>Chapter one</p>" },
            ]);
            const resolved = resolve(primaryView, {
                sectionHref: "unknown.xhtml",
                sectionOrdinal: 2,
            });
            expect(resolved?.sectionIndex).toBe(1);
        });

        it("returns null when neither href nor ordinal resolves", () => {
            const { primaryView } = makePrimaryView([
                { href: "intro.xhtml", html: "<p>Intro</p>" },
            ]);
            expect(resolve(primaryView, { sectionOrdinal: 5 })).toBeNull();
            expect(resolve(primaryView, {})).toBeNull();
        });

        it("mounts an unmounted target section before resolving the range", () => {
            const { primaryView, renderers } = makePrimaryView([
                { href: "intro.xhtml", html: "<p>Intro</p>" },
                {
                    href: "chapter1.xhtml",
                    html: "<p>The quick brown fox jumps over the lazy dog.</p>",
                    mounted: false,
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 2,
                text: "The quick brown fox jumps over the lazy dog.",
            });
            expect(renderers[1].mountCalls).toBe(1);
            expect(resolved?.range?.toString()).toContain("quick brown fox");
        });
    });

    describe("range resolution", () => {
        it("finds the cited sentence and returns a matching range", () => {
            const { primaryView } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: "<p>First sentence here. The cited sentence lives here. Last one.</p>",
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                text: "The cited sentence lives here.",
            });
            expect(resolved?.range?.toString()).toBe("The cited sentence lives here.");
        });

        it("matches text across inline markup and collapsed whitespace", () => {
            const { primaryView } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: "<p>A sentence with <em>emphasized</em>\n   words inside.</p>",
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                text: "A sentence with emphasized words inside.",
            });
            expect(resolved?.range?.toString().replace(/\s+/g, " "))
                .toBe("A sentence with emphasized words inside.");
        });

        it("skips style/script text so extracted sentences still match", () => {
            // Extraction omits non-content subtrees from item text; the live
            // walk must skip the same nodes or the flattened text diverges
            // and the extracted sentence is never found.
            const { primaryView } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: "<p>Before the rule.<style>p { color: red; }</style> The cited sentence lives here.</p>",
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                text: "The cited sentence lives here.",
            });
            expect(resolved?.range?.toString().replace(/\s+/g, " ").trim())
                .toBe("The cited sentence lives here.");
        });

        it("matches cited text that is itself literal markup (code samples)", () => {
            // Books about markup render escaped tags as visible text; the
            // cited sentence then contains literal angle brackets that must
            // not be stripped before searching the live DOM.
            const { primaryView } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: '<p>Example:</p><pre>&lt;seq type="table" textref="ch01.xhtml#t1"&gt; &lt;par&gt;…&lt;/par&gt; &lt;/seq&gt;</pre>',
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                text: '<seq type="table" textref="ch01.xhtml#t1"> <par>…</par> </seq>',
            });
            expect(resolved?.range?.toString().replace(/\s+/g, " ").trim())
                .toBe('<seq type="table" textref="ch01.xhtml#t1"> <par>…</par> </seq>');
        });

        it("strips HTML fragments from the search text", () => {
            const { primaryView } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: "<p>Plain words to find.</p>",
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                text: "<span>Plain words</span> to find.",
            });
            expect(resolved?.range?.toString()).toBe("Plain words to find.");
        });

        it("disambiguates repeated phrases via the anchor id scope", () => {
            const { primaryView, renderers } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: '<p id="p1">Repeated phrase.</p><p id="p2">Repeated phrase.</p>',
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                anchorId: "p2",
                text: "Repeated phrase.",
            });
            const secondParagraph = renderers[0].body!.querySelector("#p2")!;
            expect(resolved?.range).toBeDefined();
            expect(
                secondParagraph.contains(resolved!.range!.startContainer),
            ).toBe(true);
        });

        it("prefers a stripped-text match inside the anchor over a raw match elsewhere", () => {
            // The raw candidate (with literal tags) matches a code sample
            // outside the anchor; the anchor-scoped stripped match must win.
            const { primaryView, renderers } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: '<pre>&lt;span&gt;Plain words&lt;/span&gt; to find.</pre><p id="target">Plain words to find.</p>',
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                anchorId: "target",
                text: "<span>Plain words</span> to find.",
            });
            const anchorParagraph = renderers[0].body!.querySelector("#target")!;
            expect(resolved?.range?.toString()).toBe("Plain words to find.");
            expect(anchorParagraph.contains(resolved!.range!.startContainer)).toBe(true);
        });

        it("falls back to the anchor element contents when the text is not found", () => {
            const { primaryView } = makePrimaryView([
                {
                    href: "chapter1.xhtml",
                    html: '<p id="target">Anchor paragraph content.</p><p>Other.</p>',
                },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                anchorId: "target",
                text: "Text that appears nowhere in the section.",
            });
            expect(resolved?.range?.toString()).toBe("Anchor paragraph content.");
        });

        it("returns the section without a range when nothing can be located", () => {
            const { primaryView } = makePrimaryView([
                { href: "chapter1.xhtml", html: "<p>Some content.</p>" },
            ]);
            const resolved = resolve(primaryView, {
                sectionOrdinal: 1,
                anchorId: "missing-anchor",
                text: "Text that appears nowhere in the section.",
            });
            expect(resolved).toEqual({ sectionIndex: 0 });
        });
    });
});
