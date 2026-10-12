/**
 * Line-break joins shared by the structured and markdown text (PDF schema 5):
 * hyphen decisions, URLs, number ranges, soft hyphens and CJK text.
 */

import { describe, expect, it } from "vitest";

import {
    addBlockToVocabulary,
    decideLineJoin,
    decideSplitWord,
    joinLineTexts,
    LineJoinVocabulary,
} from "../../../src/beaver-extract/lineJoins";

function vocabularyOf(...lines: string[]): LineJoinVocabulary {
    const vocabulary = new LineJoinVocabulary();
    addBlockToVocabulary(lines, vocabulary);
    return vocabulary;
}

describe("addBlockToVocabulary", () => {
    it("collects compounds as consecutive pairs and their parts", () => {
        const vocabulary = vocabularyOf("a difference-in-differences design");
        expect([...vocabulary]).toEqual(["difference-in", "in-differences"]);
        expect(vocabulary.compoundLefts).toEqual(new Set(["difference", "in"]));
        expect(vocabulary.compoundRights).toEqual(new Set(["in", "differences"]));
        expect(vocabulary.words.has("design")).toBe(true);
    });

    it("reads compound parts with a Unicode hyphen, but not letters glued to digits", () => {
        const vocabulary = vocabularyOf("a diagnosticity\u2010adoption link", "the HNF1β-Gen and anti-COVID-19 work");
        expect(vocabulary.compoundLefts).toEqual(new Set(["diagnosticity", "anti"]));
        expect(vocabulary.compoundRights).toEqual(new Set(["adoption", "covid"]));
    });

    it("reads a word with a soft hyphen inside it as the whole word", () => {
        const vocabulary = vocabularyOf("the air\u00ADport was busy, a self-con\u00ADtained unit");
        expect(vocabulary.words.has("airport")).toBe(true);
        expect(vocabulary.words.has("air")).toBe(false);
        expect(vocabulary.compoundRights.has("contained")).toBe(true);
        // The compound set reads the raw text, as PDF schema 4 does.
        expect([...vocabulary]).toEqual(["self-con"]);
        expect(joinLineTexts(["the air-", "port was busy"], vocabulary)).toBe("the airport was busy");
        // A soft hyphen at the line end still splits the word.
        expect(vocabularyOf("an air\u00AD", "port").words.has("port")).toBe(false);
    });

    it("leaves both halves of a word split at a line end out of the words", () => {
        const vocabulary = vocabularyOf("the effects of con-", "sequences matter", "consequences differ");
        expect(vocabulary.words.has("con")).toBe(false);
        expect(vocabulary.words.has("sequences")).toBe(false);
        expect(vocabulary.words.has("consequences")).toBe(true);
        expect(vocabulary.words.has("matter")).toBe(true);
    });
});

describe("decideSplitWord", () => {
    const split = (left: string, right: string, vocabulary?: LineJoinVocabulary, leftToken = `${left}-`, rightRest = "") =>
        decideSplitWord(leftToken, left, right, rightRest, vocabulary ?? new LineJoinVocabulary());

    it("follows the document's own spelling first", () => {
        expect(split("broken", "windows", vocabularyOf("broken-windows policing"))).toBe("keep");
        expect(split("Vander", "Weele", vocabularyOf("see VanderWeele (2015)"))).toBe("join");
    });

    it("joins an ordinary hyphenation point", () => {
        expect(split("con", "sequences")).toBe("join");
        expect(split("inter", "national")).toBe("join");
    });

    it("keeps a hyphen next to another element of a hyphenated phrase", () => {
        const vocabulary = vocabularyOf("some light text here");
        expect(split("of", "the", vocabulary, "state-of-", "-art")).toBe("keep");
        expect(split("analog", "to", vocabulary, "analog-", "-digital")).toBe("keep");
        expect(split("light", "driven", vocabulary, "visible-light-")).toBe("keep");
        // A break inside the last element is a hyphenation point.
        expect(split("determina", "tion", vocabulary, "self-determina-")).toBe("join");
        expect(split("dou", "ble", vocabulary, "dou-", "-stranded")).toBe("join");
        // Elements joined with Unicode hyphens count the same.
        expect(split("of", "the", vocabulary, "state\u2010of\u2010", "\u2010art")).toBe("keep");
        expect(split("analog", "to", vocabulary, "analog\u2010", "\u2010digital")).toBe("keep");
    });

    it("keeps the hyphen before a capitalized right part or after an acronym", () => {
        expect(split("Montoliu", "Gaya")).toBe("keep");
        expect(split("non", "European")).toBe("keep");
        expect(split("HIV", "infected")).toBe("keep");
        expect(split("C", "terminus")).toBe("keep");
        expect(split("siRNA", "treated")).toBe("keep");
        expect(split("MRC", "AMED")).toBe("keep");
        // A name with an inner capital is not an acronym.
        expect(split("McKen", "zie")).toBe("join");
    });

    it("reads a hyphen before a coordinating word as suspended", () => {
        expect(split("high", "and")).toBe("suspend");
        // Also after an acronym, which would otherwise keep the hyphen.
        expect(split("DNA", "and")).toBe("suspend");
        expect(split("mis", "and", undefined, "mis-", "")).toBe("suspend");
        // "-and-" continues a hyphenated phrase.
        expect(split("cause", "and", vocabularyOf("a cause of it"), "cause-", "-effect")).toBe("keep");
    });

    it("keeps compounds of common hyphen prefixes unless a suffix follows", () => {
        expect(split("self", "identity")).toBe("keep");
        expect(split("cross", "sectional")).toBe("keep");
        expect(split("twenty", "eight")).toBe("keep");
        expect(split("cross", "ing")).toBe("join");
        expect(split("four", "teen")).toBe("join");
        // Closed words a prefix forms, and word endings after one.
        expect(split("non", "sense")).toBe("join");
        expect(split("high", "lighted")).toBe("join");
        expect(split("four", "th")).toBe("join");
        expect(split("short", "en")).toBe("join");
        expect(split("real", "istic")).toBe("join");
        // "ten" is the first syllable of many words, not a prefix.
        expect(split("ten", "sion")).toBe("join");
        expect(split("further", "more")).toBe("join");
    });

    it("keeps the hyphen when both parts are words or compound parts of the document", () => {
        const vocabulary = vocabularyOf(
            "the algorithm was generated and checked",
            "Rho-regulated microtubules",
        );
        expect(split("algorithm", "generated", vocabulary)).toBe("keep");
        expect(split("redox", "regulated", vocabulary)).toBe("keep");
        // A bound prefix forms closed words: being a word says nothing.
        expect(split("sub", "cultured", vocabularyOf("a sub group was cultured"))).toBe("join");
        expect(split("out", "come", vocabularyOf("we went out to come back"))).toBe("join");
        expect(split("off", "set", vocabularyOf("turned off the set"))).toBe("join");
        // Nor does a compound elsewhere vouch for a prefix's closed word,
        // though it does after a short element ("Li-doped").
        expect(split("under", "standing", vocabularyOf("a long-standing view"))).toBe("join");
        expect(split("bi", "cultural", vocabularyOf("cross-cultural work"))).toBe("join");
        expect(split("Li", "doped", vocabularyOf("the Zn-doped films"))).toBe("keep");
        // A bound prefix keeps its hyphen before the vowel it ends with.
        expect(split("meta", "analysis")).toBe("keep");
        expect(split("anti", "inflammatory")).toBe("keep");
        expect(split("co", "operation")).toBe("join");
    });

    it("takes no words or compound parts as evidence in German text", () => {
        // German writes compounds of words closed.
        const german = vocabularyOf(
            "Diese Ergebnisse wurden nicht durch die Methode erklärt, sondern sind auch",
            "zwischen den Gruppen sowie nach einer Studie oder einem Test, jedoch kann dieser",
            "wird werden sich dass unter dem stellen Alltags-Leben",
        );
        expect(split("unter", "stellen", german)).toBe("join");
        expect(split("Alltags", "praktiken", german)).toBe("join");
        expect(split("Literatur", "Geschichte", german)).toBe("keep");
    });

    it("joins parts that form a closed word", () => {
        const vocabulary = vocabularyOf(
            "a frame for the work where we lived else, the wrong way, inside out",
            "age-related differences in the correlation and methylation of the tumor",
            "the maneater man was eating",
        );
        // A right part that only closes words.
        expect(split("else", "where", vocabulary)).toBe("join");
        // Words that also end hyphenated compounds.
        expect(split("wrong", "way", vocabulary)).toBe("keep");
        expect(split("inside", "out", vocabulary)).toBe("keep");
        // The joined word with another ending, written closed elsewhere.
        expect(split("cor", "related", vocabulary)).toBe("join");
        expect(split("methyl", "ations", vocabularyOf("methylation of an ethyl-methyl group"))).toBe("join");
        expect(split("income", "related", vocabulary)).toBe("keep");
        // A word that only shares the start is no evidence.
        expect(split("man", "eating", vocabulary)).toBe("keep");
        // Too short a stem to stand for a word ("c-h" beside "change").
        expect(split("c", "h", vocabularyOf("a change in a-h"))).toBe("keep");
    });

    it("follows a compound the document spells with a Unicode hyphen", () => {
        const vocabulary = vocabularyOf("co\u2010operation and re\u2010use");
        expect(split("co", "operation", vocabulary)).toBe("keep");
        expect(split("re", "use", vocabulary)).toBe("keep");
        // The schema-4 compound set stays ASCII-only.
        expect([...vocabulary]).toEqual([]);
        // Unless it also writes the word closed.
        expect(split("on", "line", vocabularyOf("an on\u2010line survey", "online panels"))).toBe("join");
    });

    it("keeps only attested compounds with a plain set", () => {
        expect(decideSplitWord("broken-", "broken", "windows", "", new Set(["broken-windows"]))).toBe("keep");
        expect(decideSplitWord("algorithm-", "algorithm", "generated", "", new Set())).toBe("join");
    });
});

describe("decideLineJoin", () => {
    it("joins at a soft hyphen", () => {
        expect(decideLineJoin("das Kosten\u00AD", "verhalten der Segmente")).toBe("join");
        expect(decideLineJoin("das Kosten\u00AD ", "verhalten")).toBe("join");
    });

    it("joins, keeps or suspends a hyphen after a letter", () => {
        expect(decideLineJoin("focus on con-", "sequences here")).toBe("join");
        expect(decideLineJoin("a self-", "identity")).toBe("glue");
        expect(decideLineJoin("under high-", "and low-stress conditions")).toBe("space");
        expect(decideLineJoin("see https://example.com/some-", "article for details")).toBe("glue");
    });

    it("continues a URL or DOI cut by the break", () => {
        expect(decideLineJoin("code at https:", "//github.com/user/repo")).toBe("glue");
        expect(decideLineJoin("doi:10.1016/j.", "learninstruc.2006.09.001")).toBe("glue");
        expect(decideLineJoin("https://doi.org/10.1177/", "0193841x14531584")).toBe("glue");
        expect(decideLineJoin("(www.", "congressionalbills.org)")).toBe("glue");
        expect(decideLineJoin("(www.aietech.org.", "cn) for details")).toBe("glue");
        expect(decideLineJoin("doi: 10.1186/s13195-020-", "00633-2")).toBe("glue");
    });

    it("keeps the space the PDF set after a complete URL", () => {
        expect(decideLineJoin("Visit https://example.org/ ", "for more information.")).toBe("space");
        // A word that is also a domain ending is a word after a "/".
        expect(decideLineJoin("Visit https://example.org/ ", "in your browser.")).toBe("space");
        expect(decideLineJoin("see www.example. ", "org for details")).toBe("glue");
        // Lines that all end in a space still continue into URL text.
        expect(decideLineJoin("https://doi.org/10.1016/ ", "j.cell.2021.06.012")).toBe("glue");
        expect(decideLineJoin("https://doi.org/10.3758/s13428-019-01246- ", "w.")).toBe("glue");
    });

    it("goes on with the sentence after a URL ending in a slash, without a space at the line end", () => {
        expect(decideLineJoin("Visit https://example.org/", "for more information.")).toBe("space");
        expect(decideLineJoin("files at https://example.org/data/", "and the code")).toBe("space");
        // A path goes on.
        expect(decideLineJoin("https://huggingface.co/spaces/mouseland/", "cellpose.")).toBe("glue");
        expect(decideLineJoin("https://verfassungsblog.de/", "the-judicial-overhaul/.")).toBe("glue");
        expect(decideLineJoin("downloaded at https://example.org/", "using the supplied credentials.")).toBe("space");
        expect(decideLineJoin("http://www.jmir.org/2019/8/e15062/", "doi: 10.2196/15062")).toBe("space");
        // A path's last segment ends the line or meets punctuation.
        expect(decideLineJoin("http://infolit.be/", "edudoc), which was")).toBe("glue");
        expect(decideLineJoin("https://github.com/gambalab/", "gficf. While scripts")).toBe("glue");
        // Alone, a function word may be the path's last segment.
        expect(decideLineJoin("https://en.wiktionary.org/wiki/", "and")).toBe("glue");
        expect(decideLineJoin("https://en.wiktionary.org/wiki/", "and.")).toBe("glue");
    });

    it("keeps the space after a URL that ends its sentence", () => {
        expect(decideLineJoin("available at https://example.org/page.", "The results")).toBe("space");
        expect(decideLineJoin("at http://www.cell.com/content/full/DC1).", "for the cells")).toBe("space");
        expect(decideLineJoin("at http://example.org/data.", "results differ")).toBe("space");
    });

    it("continues a number range cut after its dash", () => {
        expect(decideLineJoin("Neurology 2020;19:422–", "33.")).toBe("glue");
        expect(decideLineJoin("ranged from 4.32%–", "13.28%.")).toBe("glue");
        expect(decideLineJoin("in the period 1978-", "2009 incomes rose")).toBe("glue");
        expect(decideLineJoin("between 2010 –", "2015")).toBe("space");
    });

    it("joins Chinese and Japanese lines without a space", () => {
        expect(decideLineJoin("ペルー的な", "要素がグローバルな")).toBe("glue");
        expect(decideLineJoin("生存分析的相关指标被引入疾病负担的评价，", "评价指标主要有")).toBe("glue");
        expect(decideLineJoin("我们使用", "Transformer 模型")).toBe("space");
        // Han extension characters outside the BMP.
        expect(decideLineJoin("常用\u{20000}", "\u{20001}字")).toBe("glue");
        // Fullwidth letters and digits break anywhere in CJK typesetting,
        // except in a phrase whose lines space its fullwidth words.
        expect(decideLineJoin("研究于２０", "２２年开展")).toBe("glue");
        expect(decideLineJoin("Ｓ", "ＮＳの利用")).toBe("glue");
        expect(decideLineJoin("我国Ａ", "股上市公司")).toBe("glue");
        expect(decideLineJoin("２０２２", "年３月")).toBe("glue");
        expect(decideLineJoin("Ｔｈｅ Ｉｍｐａｃｔ ｏｆ Ｆｉｎａｎｃｅ", "ｏｎ Ｉｎｎｏｖａｔｉｏｎ")).toBe("space");
        expect(decideLineJoin("Ｖｏｌ．３７， Ｎｏ．６", "Ｊｏｕｒｎａｌ")).toBe("space");
        expect(decideLineJoin("Ｔｈｅ\u3000ｖａｌｕｅ\u3000ｏｆ\u3000ｄａｔａ”，Ｊｏｕｒｎａｌ\u3000", "ｏｆ\u3000")).toBe("space");
        expect(decideLineJoin("Ｊｏｕｒｎａｌ\u3000", "ｏｆ")).toBe("space");
        // Not inside a number.
        expect(decideLineJoin("Ｖｏｌ． ２０", "２２ Ｎｏ．６")).toBe("glue");
    });

    it("joins Korean lines without a space only when the line has no trailing space", () => {
        expect(decideLineJoin("협약의 3개 주요 카테고리 모두", "에서 찾아볼 수 있다")).toBe("glue");
        expect(decideLineJoin("속해있다고 말이다. 그는 ", "무형유산의 일부이면서")).toBe("space");
    });

    it("reads capitals as no evidence in all-capitals text", () => {
        expect(decideLineJoin("INTER-", "NATIONAL LAW")).toBe("join");
        expect(decideLineJoin("THE SELF-DETERMINA-", "TION PROCESS")).toBe("join");
        expect(decideLineJoin("THE STATE-OF-", "THE-ART METHOD")).toBe("glue");
        expect(decideLineJoin("funded by an MRC-", "AMED award")).toBe("glue");
    });

    it("joins anything else with a space", () => {
        expect(decideLineJoin("The quick brown", "fox jumped")).toBe("space");
        expect(decideLineJoin("a hard break—", "next clause")).toBe("space");
    });
});

describe("joinLineTexts", () => {
    it("joins lines with their decisions and drops soft hyphens inside lines", () => {
        expect(joinLineTexts(["Das Kosten\u00AD", "verhalten der hypo\u00ADmag\u00ADnesemia", "Segmente"]))
            .toBe("Das Kostenverhalten der hypomagnesemia Segmente");
        expect(joinLineTexts(["a cross-", "sectional study of con-", "sequences"]))
            .toBe("a cross-sectional study of consequences");
        expect(joinLineTexts(["under high-", "and low-stress conditions"]))
            .toBe("under high- and low-stress conditions");
        expect(joinLineTexts(["DNA-", "and RNA-based assays"])).toBe("DNA- and RNA-based assays");
        expect(joinLineTexts(["a state\u2010of\u2010", "the\u2010art method"])).toBe("a state\u2010of\u2010the\u2010art method");
        expect(joinLineTexts(["non-", "sense"])).toBe("nonsense");
        expect(joinLineTexts(["the four-", "th wave"])).toBe("the fourth wave");
        // Inflections of a prefix's closed words join too.
        expect(joinLineTexts(["the short-", "ening of"])).toBe("the shortening of");
        expect(joinLineTexts(["a short-", "ener for"])).toBe("a shortener for");
        expect(joinLineTexts(["it low-", "ered the"])).toBe("it lowered the");
        expect(joinLineTexts(["the four-", "teenth wave"])).toBe("the fourteenth wave");
        expect(joinLineTexts(["a short-", "term loan"])).toBe("a short-term loan");
        expect(joinLineTexts(["growth in the low-", "teens range"])).toBe("growth in the low-teens range");
        expect(joinLineTexts(["INTER-", "NATIONAL LAW"])).toBe("INTERNATIONAL LAW");
        // A capitalized syllable of a mixed-case compound is no connector.
        expect(joinLineTexts(["die US-An-", "leihen steigen"])).toBe("die US-Anleihen steigen");
        expect(joinLineTexts(["der EU-Be-", "richt"])).toBe("der EU-Bericht");
        expect(joinLineTexts(["Visit https://example.org/ ", "for more information."]))
            .toBe("Visit https://example.org/ for more information.");
    });
});
