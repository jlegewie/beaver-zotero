import { describe, expect, it } from "vitest";
import { derivePageLabels, pageEdgeRowObservations } from "../../../src/beaver-extract/derivedPageLabels";
import {
    bboxFromXYWH,
    type PageNumberObservation,
    type RawLine,
    type RawPageData,
} from "@beaver/agent-core/extract/types";

function obs(pageIndex: number, text: string | number, extra: Partial<PageNumberObservation> = {}): PageNumberObservation {
    const t = String(text);
    const roman = /^[ivxlcdm]+$/i.test(t);
    const romanValue = (s: string) => {
        const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
        let total = 0;
        const lower = s.toLowerCase();
        for (let i = 0; i < lower.length; i++) {
            const cur = v[lower[i]], next = v[lower[i + 1]];
            total += next && next > cur ? -cur : cur;
        }
        return total;
    };
    return {
        pageIndex,
        value: roman ? romanValue(t) : Number(t),
        text: t,
        roman,
        position: "bottom",
        ...extra,
    };
}

/** Observations `start, start+1, …` on pages `from..to`. */
function run(from: number, to: number, start: number): PageNumberObservation[] {
    const out: PageNumberObservation[] = [];
    for (let p = from; p <= to; p++) out.push(obs(p, start + (p - from)));
    return out;
}

describe("derivePageLabels", () => {
    it("labels a journal article from its printed page numbers", () => {
        // Page 0 is a download cover, page 1 the unnumbered first page.
        const labels = derivePageLabels(run(2, 9, 268), 10);
        expect(labels[0]).toBeUndefined();
        expect(labels[1]).toBe("267");
        expect(labels[2]).toBe("268");
        expect(labels[9]).toBe("275");
    });

    it("fills unnumbered pages inside a run", () => {
        const observations = run(0, 9, 101).filter((o) => o.pageIndex % 2 === 1);
        const labels = derivePageLabels(observations, 10);
        expect(labels[4]).toBe("105");
        expect(labels[8]).toBe("109");
    });

    it("keeps a Roman front matter and an Arabic body that starts on unnumbered pages", () => {
        // ii..xiv on pages 1..13, then the body prints 3, 4, … from page 16:
        // its part title (page 14) and chapter opener (page 15) are 1 and 2.
        const roman = ["ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv"]
            .map((text, k) => obs(k + 1, text));
        const labels = derivePageLabels([...roman, ...run(16, 30, 3)], 31);
        expect(labels[0]).toBe("i");
        expect(labels[13]).toBe("xiv");
        expect(labels[14]).toBe("1");
        expect(labels[15]).toBe("2");
        expect(labels[16]).toBe("3");
    });

    it("leaves the page before a numbering's page 1 to the numbering before", () => {
        const roman = ["i", "ii", "iii"].map((text, k) => obs(k, text));
        const labels = derivePageLabels([...roman, ...run(4, 6, 1)], 7);
        expect(labels[3]).toBe("iv");
        expect(labels[4]).toBe("1");
    });

    it("keeps the case of printed Roman numerals", () => {
        const roman = ["IV", "V", "VI", "VII"].map((text, k) => obs(k, text));
        expect(derivePageLabels(roman, 4)).toEqual({ 0: "IV", 1: "V", 2: "VI", 3: "VII" });
    });

    it("ignores numerals that do not advance with the page index", () => {
        const years = [0, 1, 2, 3, 4].map((p) => obs(p, 2021, { position: "top" }));
        const chapter = [0, 1, 2, 3, 4].map((p) => obs(p, 3, { position: "top" }));
        expect(derivePageLabels([...years, ...chapter], 5)).toEqual({});
    });

    it("needs three numbered pages, or two in a short document", () => {
        expect(derivePageLabels(run(3, 4, 10), 10)).toEqual({});
        expect(derivePageLabels(run(0, 1, 1306), 2)).toEqual({ 0: "1306", 1: "1307" });
    });

    it("keeps the better attested of two numberings printed on the same pages", () => {
        // Journal pagination on every page; a "page x of n" counter that
        // skips the first page.
        const journal = run(0, 11, 450);
        const counter = run(1, 11, 2).map((o) => ({ ...o, position: "top" as const }));
        const labels = derivePageLabels([...journal, ...counter], 12);
        expect(labels[0]).toBe("450");
        expect(labels[11]).toBe("461");
    });

    it("keeps restarted numberings in sequence", () => {
        const labels = derivePageLabels([...run(0, 9, 1), ...run(10, 19, 1)], 20);
        expect(labels[9]).toBe("10");
        expect(labels[10]).toBe("1");
        expect(labels[19]).toBe("10");
    });

    it("leaves pages whose number would be below 1 unlabeled", () => {
        const labels = derivePageLabels(run(1, 5, 1), 6);
        expect(labels[0]).toBeUndefined();
        expect(labels[1]).toBe("1");
    });

    it("does not extend a run over pages that print another numbering too short to be a run", () => {
        const labels = derivePageLabels([...run(0, 4, 1), obs(5, "i"), obs(6, "ii")], 7);
        expect(labels[4]).toBe("5");
        expect(labels[5]).toBeUndefined();
        expect(labels[6]).toBeUndefined();
    });

    it("does not treat numerals repeated on every page as another numbering", () => {
        // A publisher logo prints "1" and "3" in every footer; the first page
        // also has an affiliation marker "2". "2" on page 0 and "3" on page 1
        // step with the page index by chance.
        const furniture = [0, 1, 2, 3, 4, 5].flatMap((p) => [obs(p, 1), obs(p, 3)]);
        const labels = derivePageLabels(
            [...furniture, obs(0, 2), ...run(1, 5, 1128).map((o) => ({ ...o, position: "top" as const }))],
            6,
        );
        expect(labels[0]).toBe("1127");
    });

    it("keeps the last page of a \"page x of n\" footer", () => {
        // Every footer's last word is the page count "2".
        const footers = [0, 1].flatMap((p) => [
            obs(p, `${p + 1} of 2`, { value: p + 1 }),
            obs(p, 2, { edge: true }),
        ]);
        expect(derivePageLabels(footers, 2)).toEqual({ 0: "1", 1: "2" });
    });

    it("does not extend past a page that says it is the last", () => {
        // A cover sheet is appended after "3 of 3".
        const footers = [0, 1, 2].map((p) => obs(p, `${p + 1} of 3`, { value: p + 1 }));
        expect(derivePageLabels(footers, 4)).toEqual({ 0: "1", 1: "2", 2: "3" });
    });

    it("does not extend over a page whose lone counter names another number", () => {
        // A one-page supplement after an article printed 101-105.
        const labels = derivePageLabels([...run(0, 4, 101), obs(5, "Page 1", { value: 1 })], 6);
        expect(labels[4]).toBe("105");
        expect(labels[5]).toBeUndefined();
    });

    it("keeps page numbers that occur inside a letter-spaced number at the same place", () => {
        // A letter-spaced year "2 0 2 1" in the footer of pages printed 20-22.
        const year = [0, 1, 2].map((p) => obs(p, 2021, { spaced: true, edge: true }));
        expect(derivePageLabels([...run(0, 2, 20), ...year], 3)).toEqual({ 0: "20", 1: "21", 2: "22" });
    });

    it("reads the last-page counter with non-ASCII or padded digits", () => {
        for (const last of ["Page \uFF13 of \uFF13", "Page 03 of 3"]) {
            const footers = [
                obs(0, "Page 1 of 3", { value: 1 }),
                obs(1, "Page 2 of 3", { value: 2 }),
                obs(2, last, { value: 3 }),
            ];
            expect(derivePageLabels(footers, 4)[3]).toBeUndefined();
        }
    });

    it("drops only the spaced number's own digits, not page numbers beside it", () => {
        const box = (l: number, r: number) => bboxFromXYWH(l, 760, r - l, 10, "top-left");
        // A letter-spaced year "2 0 2 3" (with its digits read singly) and
        // page numbers 1-3 further along the same footer.
        const footer = [0, 1, 2].flatMap((p) => [
            obs(p, 2023, { spaced: true, edge: true, bbox: box(300, 340) }),
            obs(p, 2, { edge: true, bbox: box(300, 306) }),
            obs(p, 3, { edge: true, bbox: box(334, 340) }),
            obs(p, p + 1, { bbox: box(500, 506) }),
        ]);
        expect(derivePageLabels(footer, 3)).toEqual({ 0: "1", 1: "2", 2: "3" });
    });

    it("does not extend over a page whose lone bare counter names another number", () => {
        for (const text of ["1 of 1", "1/1"]) {
            const labels = derivePageLabels([...run(0, 4, 101), obs(5, text, { value: 1 })], 6);
            expect(labels[5]).toBeUndefined();
        }
    });

    it("fills a gap page whose stray number disagrees with the run around it", () => {
        // An OCR misread ("page 51" for 61) inside a continuous numbering.
        const pages = [...run(0, 1, 59), obs(2, "page 51", { value: 51 }), ...run(3, 4, 62)];
        expect(derivePageLabels(pages, 5)[2]).toBe("61");
    });

    it("fills gaps over pages that print only a numbering running alongside", () => {
        // Journal pagination in the header (missing on page 3) and a
        // "page x of 6" counter in every footer.
        const header = run(0, 5, 450).filter((o) => o.pageIndex !== 3).map((o) => ({ ...o, position: "top" as const }));
        const counter = [0, 1, 2, 3, 4, 5].map((p) => obs(p, `Page ${p + 1} of 6`, { value: p + 1, edge: true }));
        const labels = derivePageLabels([...header, ...counter], 6);
        expect(labels[3]).toBe("453");
    });

    it("does not build a numbering from numerals every footer repeats", () => {
        const footers = [0, 1, 2, 3, 4, 5].flatMap((p) => [obs(p, 1), obs(p, 2), obs(p, 3)]);
        expect(derivePageLabels(footers, 6)).toEqual({});
    });

    it("keeps a page number that equals a fixed numeral in the same footer", () => {
        // Pages 16-17 printed beside a fixed volume number 16: page 0 prints
        // "16" twice, page 1 once.
        const labels = derivePageLabels([obs(0, 16, { occurrences: 2 }), obs(1, 16), obs(1, 17)], 2);
        expect(labels).toEqual({ 0: "16", 1: "17" });
    });

    it("does not count repeats within a page in a longer document", () => {
        // A contents page (index 0) prints "1" twice ("1 Einleitung … 1"), the
        // chapter opener a large "1" at the top; the book skips page 4.
        const top = { position: "top" as const };
        const labels = derivePageLabels([
            obs(0, 1, { ...top, occurrences: 2 }), obs(1, 1, top), obs(1, 1),
            obs(2, 2, top), obs(3, 3, top), ...run(4, 7, 5).map((o) => ({ ...o, ...top })),
        ], 8);
        expect(labels[0]).toBeUndefined();
        expect(labels[1]).toBe("1");
        expect(labels[4]).toBe("5");
    });

    it("labels a prefixed numbering with its prefix", () => {
        // An article's pages 2817-2823, then online-only pages e1-e4: the
        // article's numbering does not extend onto e1.
        const ePages = [7, 8, 9, 10].map((p) => obs(p, `e${p - 6}`, { value: p - 6, prefix: "e" }));
        const labels = derivePageLabels([...run(0, 6, 2817), ...ePages], 11);
        expect(labels[6]).toBe("2823");
        expect(labels[7]).toBe("e1");
        expect(labels[10]).toBe("e4");
    });

    it("keeps an article number's folio prefix", () => {
        const folios = [1, 2, 3, 4].map((p) => obs(p, `014105-${p + 1}`, { value: p + 1, prefix: "014105-" }));
        expect(derivePageLabels(folios, 5)).toEqual({
            0: "014105-1", 1: "014105-2", 2: "014105-3", 3: "014105-4", 4: "014105-5",
        });
    });

    it("ignores an article-number folio whose counter does not start in the file", () => {
        // A volume and page ("92:1235") steps with the pages too.
        const folios = [0, 1, 2, 3].map((p) => obs(p, `92:${1235 + p}`, { value: 1235 + p, prefix: "92:" }));
        expect(derivePageLabels(folios, 4)).toEqual({});
    });

    it("keeps zero-padded page numbers padded", () => {
        const padded = Array.from({ length: 12 }, (_, p) => obs(p, String(p + 1).padStart(2, "0")));
        const labels = derivePageLabels(padded.filter((o) => o.pageIndex !== 4), 12);
        expect(labels[0]).toBe("01");
        expect(labels[4]).toBe("05");
        expect(labels[11]).toBe("12");
    });

    it("extends onto a chapter opener whose chapter numeral is set larger than the folios", () => {
        // Folios 3–6 at indices 2–5; the opener at index 1 prints a display
        // chapter numeral "1" that margin detection removed.
        const box = (height: number) => bboxFromXYWH(300, 760, 12, height, "top-left");
        const folios = [2, 3, 4, 5].map((p) => obs(p, p + 1, { bbox: box(9) }));
        const chapter = obs(1, 1, { position: "top", bbox: box(40) });
        const labels = derivePageLabels([chapter, ...folios], 6);
        expect(labels[0]).toBe("1");
        expect(labels[1]).toBe("2");
    });

    it("does not extend onto a page whose folio, set like the run's, is one off", () => {
        const box = bboxFromXYWH(300, 760, 12, 9, "top-left");
        const folios = [2, 3, 4, 5].map((p) => obs(p, p + 2, { bbox: box }));
        const labels = derivePageLabels([obs(1, 2, { bbox: box }), ...folios], 6);
        expect(labels[1]).toBeUndefined();
    });

    it("does not extend over a page whose prefixed folio is one off", () => {
        // S4 is missing from the file: the page after S3 prints S5.
        const folio = (p: number, n: number) => obs(p, `S${n}`, { value: n, prefix: "S", edge: true });
        const labels = derivePageLabels([folio(0, 1), folio(1, 2), folio(2, 3), folio(3, 5)], 4);
        expect(labels[2]).toBe("S3");
        expect(labels[3]).toBeUndefined();
    });

    it("still extends onto a contents page whose rows end in nearby entries", () => {
        // The unnumbered contents page vii lists "Illustrations … viii".
        const folios = ["viii", "ix", "x", "xi"].map((t, k) => obs(k + 1, t));
        const labels = derivePageLabels([obs(0, "viii", { edge: true, position: "top" }), ...folios], 5);
        expect(labels[0]).toBe("vii");
    });

    it("extends a run over a counter that runs alongside it", () => {
        // Journal folios 451–455 on pages 1–5 and a "Page N of 6" counter
        // on every page: the unnumbered first page is still the journal's 450.
        const counter = [0, 1, 2, 3, 4, 5].map((p) => obs(p, `Page ${p + 1} of 6`, { value: p + 1, edge: true }));
        const folios = [1, 2, 3, 4, 5].map((p) => obs(p, 450 + p));
        const labels = derivePageLabels([...counter, ...folios], 6);
        expect(labels[1]).toBe("451");
        expect(labels[0]).toBe("450");
    });

    it("keeps the zero padding of a counter's page number", () => {
        const labels = derivePageLabels([0, 1, 2].map((p) => obs(p, `Page 0${p + 1} of 3`, { value: p + 1 })), 3);
        expect(labels).toEqual({ 0: "01", 1: "02", 2: "03" });
    });

    it("does not extend past a parallel counter's last page", () => {
        // Folios 101–103 beside "Page 1 of 3" … "Page 3 of 3", then an
        // appended sheet of the same size.
        const counter = [0, 1, 2].map((p) => obs(p, `Page ${p + 1} of 3`, { value: p + 1, edge: true }));
        const folios = [0, 1, 2].map((p) => obs(p, 101 + p));
        const labels = derivePageLabels([...counter, ...folios], 4);
        expect(labels[2]).toBe("103");
        expect(labels[3]).toBeUndefined();
    });

    it("weighs zero padding by page, not by how many readings a page has", () => {
        // A fullwidth "０１" is read three times (margin removal, the edge
        // row's normalized word "01", its own line); a plain "4" twice.
        const fullwidth = [0, 1, 2].flatMap((p) => {
            const text = `０${String.fromCharCode(0xff11 + p)}`;
            return [
                obs(p, text, { value: p + 1 }),
                obs(p, `0${p + 1}`, { value: p + 1, edge: true }),
                obs(p, text, { value: p + 1, edge: true, position: "top" }),
            ];
        });
        const plain = [3, 4, 5, 6].flatMap((p) => [obs(p, p + 1), obs(p, p + 1, { edge: true })]);
        const labels = derivePageLabels([...fullwidth, ...plain], 7);
        expect(labels[3]).toBe("4");
        expect(labels[6]).toBe("7");
    });

    it("does not pad a numbering that pads only a stray number", () => {
        const labels = derivePageLabels([...run(0, 5, 1), obs(6, "07"), ...run(7, 9, 8)], 10);
        expect(labels[6]).toBe("7");
    });

    it("does not extend a run onto a sheet of another size", () => {
        // A Letter-size download cover before a book-size article, and a
        // landscape table page at its end.
        const sizes = [
            { width: 612, height: 792 },
            ...Array.from({ length: 8 }, () => ({ width: 432, height: 648 })),
            { width: 648, height: 432 },
        ];
        const labels = derivePageLabels(run(1, 8, 101), 10, sizes);
        expect(labels[0]).toBeUndefined();
        expect(labels[1]).toBe("101");
        expect(labels[9]).toBe("109");
    });

    it("extends a run onto a page whose size matches one of its numbered pages nearby", () => {
        // Scanned pages vary in size.
        const sizes = [478, 498, 472, 486, 480].map((width) => ({ width, height: 800 }));
        const labels = derivePageLabels(run(1, 4, 20), 5, sizes);
        expect(labels[0]).toBe("19");
    });

    it("does not extend over a page that prints a number just off the run's", () => {
        // Page 5 prints 43 under a removed page number, where the run that
        // starts after it would give 44: a page is missing from the file.
        const labels = derivePageLabels([...run(0, 4, 37), obs(5, 43), ...run(6, 9, 45)], 10);
        expect(labels[4]).toBe("41");
        expect(labels[5]).toBeUndefined();
        expect(labels[6]).toBe("45");
    });

    it("still extends over a page whose removed number is far from the run's", () => {
        // A chapter opening's large chapter number.
        const labels = derivePageLabels([obs(1, 4, { position: "top" }), ...run(2, 9, 122)], 10);
        expect(labels[1]).toBe("121");
    });

    it("still extends over pages whose only numerals are lone noise", () => {
        // Page 1 is the article's unnumbered first page; its footer prints a year.
        const labels = derivePageLabels([obs(1, 2014), ...run(2, 9, 268)], 10);
        expect(labels[1]).toBe("267");
    });
});

function line(text: string, x: number, y: number): RawLine {
    return {
        wmode: 0,
        bbox: bboxFromXYWH(x, y, Math.max(1, text.length * 6), 10, "top-left"),
        font: { name: "T", family: "T", weight: "normal", style: "normal", size: 10 },
        x,
        y,
        text,
    };
}

function page(pageIndex: number, lines: RawLine[]): RawPageData {
    return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: 600,
        height: 800,
        viewBox: [0, 0, 600, 800],
        rotation: 0,
        blocks: [{ type: "text", bbox: bboxFromXYWH(0, 0, 600, 800, "top-left"), lines }],
    };
}

describe("pageEdgeRowObservations", () => {
    const body = (y: number) => line("Body text with 12 numbers in 2021 and more words", 60, y);

    it("reads page numbers in the top and bottom rows, inside or outside the margin zones", () => {
        const pages = [
            // Running head below an 80pt zone, number at its end.
            page(0, [line("Index of school segregation", 60, 100), line("645", 500, 100), body(140), body(700)]),
            // Number alone at the foot of the page.
            page(1, [body(100), body(140), body(600), line("646", 290, 740)]),
            // "Page | 647" footer.
            page(2, [body(100), body(140), body(600), line("Page | 647", 280, 740)]),
        ];
        const found = pageEdgeRowObservations(pages).map((o) => [o.pageIndex, o.value, o.position]);
        expect(found).toEqual(expect.arrayContaining([[0, 645, "top"], [1, 646, "bottom"], [2, 647, "bottom"]]));
        expect(found.some(([, value]) => value === 12 || value === 2021)).toBe(false);
    });

    it("does not read numbered section headings as page numbers", () => {
        const pages = ["1 Introduction", "2 Methods", "3 Results"].map((heading, p) => page(p, [
            line(heading, 60, 100), body(140), body(600), body(700),
        ]));
        expect(derivePageLabels(pageEdgeRowObservations(pages), 3)).toEqual({});
    });

    it("still reads running heads that open with their folio", () => {
        // Verso heads repeat the authors, recto heads the title.
        const heads = ["644 R. Allen and A. Vignoles", "School segregation 645", "646 R. Allen and A. Vignoles"];
        const pages = heads.map((head, p) => page(p, [line(head, 60, 40), body(100), body(140), body(600), body(700)]));
        expect(derivePageLabels(pageEdgeRowObservations(pages), 3)).toEqual({ 0: "644", 1: "645", 2: "646" });
    });

    it("discounts margin detection's reading of a numbered heading too", () => {
        // A heading inside the top margin zone is also read by margin
        // detection, which has no view of whether its row text repeats.
        const pages = ["1 Introduction", "2 Methods", "3 Results"].map((heading, p) => page(p, [
            line(heading, 60, 40), body(100), body(140), body(600), body(700),
        ]));
        const margin = ["1 Introduction", "2 Methods", "3 Results"].map((heading, p) => (
            obs(p, p + 1, { position: "top", edge: true, bbox: line(heading, 60, 40).bbox })
        ));
        expect(derivePageLabels([...margin, ...pageEdgeRowObservations(pages)], 3)).toEqual({});
    });

    it("keeps a folio printed in its own row above an equal section number", () => {
        const headings = ["1 Introduction", "2 Methods", "3 Results"];
        const pages = headings.map((heading, p) => page(p, [
            line(String(p + 1), 520, 20), line(heading, 60, 40), body(100), body(140), body(600), body(700),
        ]));
        const margin = headings.flatMap((heading, p) => [
            obs(p, p + 1, { position: "top", bbox: line(String(p + 1), 520, 20).bbox }),
            obs(p, p + 1, { position: "top", edge: true, bbox: line(heading, 60, 40).bbox }),
        ]);
        expect(derivePageLabels([...margin, ...pageEdgeRowObservations(pages)], 3)).toEqual({ 0: "1", 1: "2", 2: "3" });
    });

    it("reads alternating running heads of a two-page document", () => {
        const heads = ["644 R. Allen and A. Vignoles", "645 School segregation"];
        const pages = heads.map((head, p) => page(p, [line(head, 60, 40), body(100), body(140), body(600), body(700)]));
        expect(derivePageLabels(pageEdgeRowObservations(pages), 2)).toEqual({ 0: "644", 1: "645" });
    });

    it("joins letter-spaced digits in a row", () => {
        const pages = [page(0, [line("2", 500, 40), line("1", 507, 40), body(100), body(140), body(600), body(700)])];
        expect(pageEdgeRowObservations(pages).map((o) => o.value)).toContain(21);
    });

    it("reads a page counter split into lines as one counter", () => {
        // Three numbered pages and an appended cover sheet.
        const pages = [0, 1, 2].map((p) => page(p, [
            body(100), body(140), body(600),
            line(`Page ${p + 1}`, 250, 740), line("of 3", 320, 740),
        ]));
        pages.push(page(3, [body(100), body(140), body(600), body(700)]));
        expect(derivePageLabels(pageEdgeRowObservations(pages), 4)).toEqual({ 0: "1", 1: "2", 2: "3" });
    });

    it("gives a row's first and last word the box of its own line", () => {
        const pages = [page(0, [line("1", 30, 40), line("16 The Sublime Object", 40, 40), body(100), body(140), body(600), body(700)])];
        const first = pageEdgeRowObservations(pages).find((o) => o.text === "1");
        expect(first?.bbox).toMatchObject({ l: 30, r: 36 });
    });

    it("reads page numbers set between dashes", () => {
        const pages = [page(0, [body(100), body(140), body(600), line("- 112 -", 290, 740)])];
        expect(pageEdgeRowObservations(pages).map((o) => o.value)).toContain(112);
    });

    it("reads prefixed folios and labels them with their prefix", () => {
        const pages = [1, 2, 3].map((n, p) => page(p, [
            body(100), body(140), body(600), line(`Cell Reports 40, August 23, 2022 e${n}`, 60, 740),
        ]));
        expect(derivePageLabels(pageEdgeRowObservations(pages), 3)).toEqual({ 0: "e1", 1: "e2", 2: "e3" });
    });

    it("does not read a caption's prefixed number as a folio", () => {
        const pages = [1, 2, 3].map((n, p) => page(p, [
            body(100), body(140), body(600), line("Figure", 60, 740), line(`S${n}`, 110, 740),
        ]));
        pages.push(page(3, [body(100), body(140), body(600), line("Table S4", 60, 740)]));
        expect(pageEdgeRowObservations(pages).some((o) => o.prefix !== undefined)).toBe(false);
    });

    it("does not read a letter a scan gives for a digit as a prefix", () => {
        // "I3" is a misread 13, "T53" a misread 153.
        const pages = [
            page(0, [body(100), body(140), body(600), line("I3", 290, 740)]),
            page(1, [body(100), body(140), body(600), line("T53", 290, 740)]),
        ];
        expect(pageEdgeRowObservations(pages).some((o) => o.prefix !== undefined)).toBe(false);
    });

    it("splits row words at U+FFFD", () => {
        const pages = [
            page(0, [line("ACKNOWLEDGMENTS�xi", 60, 40), body(100), body(140), body(600)]),
            page(1, [body(100), body(140), body(600), line("-�3�-", 290, 740)]),
        ];
        const found = pageEdgeRowObservations(pages).map((o) => [o.pageIndex, o.value]);
        expect(found).toEqual(expect.arrayContaining([[0, 11], [1, 3]]));
    });

    it("counts a page number that equals a fixed numeral in its row", () => {
        const pages = [16, 17].map((n, p) => page(p, [
            body(100), body(140), body(600), line("16", 60, 740), line(String(n), 500, 740),
        ]));
        const observations = pageEdgeRowObservations(pages);
        expect(observations.find((o) => o.pageIndex === 0 && o.text === "16")?.occurrences).toBe(2);
        expect(derivePageLabels(observations, 2)).toEqual({ 0: "16", 1: "17" });
    });

    it("counts a single-digit page number beside an equal fixed numeral", () => {
        const pages = [1, 2].map((n, p) => page(p, [
            body(100), body(140), body(600), line("1", 60, 740), line(String(n), 500, 740),
        ]));
        expect(derivePageLabels(pageEdgeRowObservations(pages), 2)).toEqual({ 0: "1", 1: "2" });
    });

    it("counts the pieces of one number and broken-up text once", () => {
        const pages = [
            page(0, [body(100), body(140), body(600), line("1", 290, 740), line("1", 297, 740)]),
            page(1, [body(100), body(140), body(600), line("2 1 0 7 i 2", 60, 740)]),
            // Split glyphs too far apart to read as one spaced number.
            page(2, [body(100), body(140), body(600), line("9", 290, 740), line("9", 305, 740)]),
        ];
        expect(pageEdgeRowObservations(pages).every((o) => (o.occurrences ?? 1) === 1)).toBe(true);
    });

    it("ignores footnote markers set smaller than the text they lead", () => {
        const sized = (text: string, x: number, y: number, size: number): RawLine => ({
            ...line(text, x, y),
            bbox: bboxFromXYWH(x, y, Math.max(1, text.length * 0.6 * size), size, "top-left"),
            font: { name: "T", family: "T", weight: "normal", style: "normal", size },
        });
        const separate = [0, 1, 2].map((p) => page(p, [
            body(100), body(140), body(600),
            sized(String(p + 1), 60, 740, 5), sized("See the appendix for details.", 64, 740, 9),
        ]));
        expect(derivePageLabels(pageEdgeRowObservations(separate), 3)).toEqual({});
        // A superscript marker raised into a text row of its own.
        const raised = [0, 1, 2].map((p) => page(p, [
            body(100), body(140), body(600),
            sized(String(p + 1), 60, 736, 5), sized("See the appendix for details.", 64, 740, 9),
        ]));
        expect(derivePageLabels(pageEdgeRowObservations(raised), 3)).toEqual({});
        // The marker and its text in one line, told apart by style runs.
        const merged = [0, 1, 2].map((p) => {
            const footnote = sized(`${p + 1} See the appendix for details.`, 60, 740, 5);
            footnote.styleRuns = [
                { font: footnote.font, chars: 1, letters: 0 },
                { font: { ...footnote.font, size: 9 }, chars: 24, letters: 22 },
            ];
            return page(p, [body(100), body(140), body(600), footnote]);
        });
        expect(derivePageLabels(pageEdgeRowObservations(merged), 3)).toEqual({});
        // A running foot whose page number matches its text still counts.
        const feet = [0, 1, 2].map((p) => page(p, [
            body(100), body(140), body(600), line(`${p + 7} Journal of Things`, 60, 740),
        ]));
        expect(derivePageLabels(pageEdgeRowObservations(feet), 3)).toEqual({ 0: "7", 1: "8", 2: "9" });
        // So does one set beside a taller separator rule.
        const ruled = [0, 1, 2].map((p) => page(p, [
            body(100), body(140), body(600),
            sized(String(p + 31), 42, 740, 7), sized("|", 52, 738, 10), sized("RESEARCH MATTERS", 60, 740, 7),
        ]));
        expect(derivePageLabels(pageEdgeRowObservations(ruled), 3)).toEqual({ 0: "31", 1: "32", 2: "33" });
    });

    it("ignores rows in the middle of the page", () => {
        const pages = [page(0, [body(100), body(140), line("37", 290, 400), body(600), body(700)])];
        expect(pageEdgeRowObservations(pages)).toEqual([]);
    });
});

describe("pageEdgeRowObservations on sideways pages", () => {
    /** A line set sideways (`/Rotate 90`): a vertical strip in MuPDF's frame. */
    function sideways(text: string, x: number, y: number): RawLine {
        return {
            wmode: 0,
            bbox: bboxFromXYWH(x, y, 10, Math.max(1, text.length * 6), "top-left"),
            font: { name: "T", family: "T", weight: "normal", style: "normal", size: 10 },
            x,
            y,
            text,
            rotation: 90,
        };
    }

    it("reads running heads at the displayed top of a rotated page", () => {
        const pages = [0, 1, 2, 3, 4].map((pageIndex) => {
            // In MuPDF's frame the head is neither the topmost nor the
            // bottommost row; displayed upright it is the top row.
            const lines = [sideways(`${100 + pageIndex} Journal title`, 560, 300)];
            [0, 100, 500, 600].forEach((y, k) => {
                for (let x = 100 + 5 * k; x <= 500; x += 20) {
                    lines.push(sideways("Body text that runs sideways", x, y));
                }
            });
            return page(pageIndex, lines);
        });
        const labels = derivePageLabels(pageEdgeRowObservations(pages), 5);
        expect(labels).toEqual({ 0: "100", 1: "101", 2: "102", 3: "103", 4: "104" });
    });
});
