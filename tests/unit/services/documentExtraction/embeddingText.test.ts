import { describe, expect, it } from 'vitest';

import type { DocumentItem, StructuredDocument } from '@beaver/agent-core/extract/schema';
import type { DomDocument, DomItem } from '@beaver/agent-core/extract/document/dom/schema';
import { deriveEmbeddingText, isUsableEmbeddingBody } from '../../../../src/services/documentExtraction/embeddingText';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type Rect = [number, number, number, number];

interface ItemSpec {
    kind?: 'text' | 'section_header' | 'list_item' | 'footnote' | 'caption';
    text: string;
    bbox?: Rect;
}

const heading = (text: string, bbox?: Rect): ItemSpec => ({ kind: 'section_header', text: `## ${text}`, bbox });
const para = (text: string, bbox?: Rect): ItemSpec => ({ kind: 'text', text, bbox });

/** Build a structured PDF document; items without a bbox are stacked top to bottom. */
function pdf(pages: ItemSpec[][], pageCount = pages.length): StructuredDocument {
    return {
        pageCount,
        bboxOrigin: 'top-left',
        bboxPrecision: 1,
        pages: pages.map((items, index) => {
            let y = 60;
            return {
                index,
                width: 600,
                height: 800,
                viewBox: [0, 0, 600, 800],
                rotation: 0,
                items: items.map((spec, order) => {
                    const lines = Math.max(1, Math.ceil(spec.text.length / 90));
                    const bbox = spec.bbox ?? [50, y, 550, y + lines * 12];
                    y = bbox[3] + 8;
                    const kind = spec.kind ?? 'text';
                    const base = { id: `${kind}${index}.${order}`, pageIndex: index, order, bbox, text: spec.text };
                    return (kind === 'section_header' ? { ...base, kind, level: 1 } : { ...base, kind }) as DocumentItem;
                }),
            };
        }),
    };
}

function dom(sections: Array<{ label?: string; items: Array<[DomItem['kind'], string]> }>): DomDocument {
    return {
        sectionCount: sections.length,
        sections: sections.map((section, index) => ({
            index,
            rawHref: `section${index}.xhtml`,
            label: section.label,
            items: section.items.map(([kind, text], order) => ({ id: `i${index}.${order}`, kind, sectionIndex: index, order, text })),
        })),
        citationIndex: {},
        diagnostics: { extractedTextChars: 0, sourceTextChars: 0, textCoverage: null },
    };
}

/** A sentence-rich paragraph of roughly `words` words about `topic`. */
function prose(topic: string, words = 80): string {
    const sentence = `This study examines ${topic} across several settings and reports new evidence on its causes and consequences.`;
    const perSentence = sentence.split(' ').length;
    return Array.from({ length: Math.ceil(words / perSentence) }, () => sentence).join(' ');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveEmbeddingText', () => {
    it('uses a labeled abstract and skips article metadata between the label and its text', () => {
        const doc = pdf([[
            heading('Securitized banking and the run on repo'),
            heading('a b s t r a c t'),
            para('Article history: Received 14 July 2010 Accepted 9 November 2010'),
            para('Keywords: Financial crisis; Panic; Securitization'),
            para(prose('the run on repo during the financial crisis')),
            heading('1. Introduction'),
            para(prose('an unrelated introduction topic')),
        ]]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.bodySource).toBe('abstract');
        expect(result.body).toContain('the run on repo during the financial crisis');
        expect(result.body).not.toContain('unrelated introduction');
        expect(result.body).not.toContain('Article history');
        expect(result.keywords).toBe('Financial crisis; Panic; Securitization');
        expect(result.text).toBe(`${result.title}\n\nKeywords: ${result.keywords}\n\n${result.body}`);
    });

    it('extracts inline abstract labels and keeps structured abstract parts together', () => {
        const inline = deriveEmbeddingText({
            contentKind: 'pdf',
            document: pdf([[para(`ABSTRACT: ${prose('employee treatment policies', 60)}`)]]),
        });
        expect(inline.bodySource).toBe('abstract');
        expect(inline.body.startsWith('This study examines employee treatment policies')).toBe(true);

        const structured = deriveEmbeddingText({
            contentKind: 'pdf',
            document: pdf([[
                heading('Abstract'),
                heading('BACKGROUND'),
                para(prose('cognitive processing therapy', 30)),
                heading('METHODS'),
                para(prose('a meta-analysis of randomized trials', 30)),
                heading('Introduction'),
                para(prose('a separate introduction')),
            ]]),
        });
        expect(structured.bodySource).toBe('abstract');
        expect(structured.body).toMatch(/^BACKGROUND: .*cognitive processing therapy.*METHODS: .*meta-analysis/);
        expect(structured.body).not.toContain('separate introduction');
    });

    it('keeps structured abstract lines whose bold run-in heads made them headings', () => {
        const result = deriveEmbeddingText({
            contentKind: 'pdf',
            document: pdf([[
                heading('Large language models for generating medical examinations: systematic review'),
                heading('Abstract'),
                heading('Background Writing multiple choice questions (MCQs) for the purpose of medical exams is challenging. It requires'),
                heading('extensive medical knowledge, time and effort from medical educators. This systematic review focuses on large language models.'),
                heading('Methods The authors searched for studies published up to November 2023. Search terms focused on LLMs'),
                para('generated MCQs for medical examinations. Non-English studies were excluded. MEDLINE was used as a search database.'),
                heading('Results Overall, eight studies published between April 2023 and October 2023 were included in the review.'),
                heading('Keywords Large language models, Generative pre-trained transformer, Multiple choice questions, Medical'),
                heading('Background'),
                para(prose('an unrelated background section')),
            ]]),
        });

        expect(result.bodySource).toBe('abstract');
        expect(result.body).toMatch(/^Background: Writing multiple choice questions .* It requires extensive medical knowledge/);
        expect(result.body).toContain('Methods: The authors searched');
        expect(result.body).toContain('generated MCQs for medical examinations');
        expect(result.body).toContain('Results: Overall, eight studies');
        expect(result.body).not.toContain('Generative pre-trained');
        expect(result.body).not.toContain('unrelated background');
    });

    it('does not treat words that start with a label as labels', () => {
        const opening = `Abstraction is central to mathematics. ${prose('abstraction in mathematical practice', 60)}`;
        const doc = pdf([[heading('On Abstraction'), para(opening), para('Keywordsearch engines index documents by terms.')]]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.bodySource).toBe('opening');
        expect(result.body.startsWith('Abstraction is central to mathematics.')).toBe(true);
        expect(result.keywords).toBeNull();
    });

    it('ignores abstract labels that appear after substantial body text', () => {
        const doc = pdf([
            [para(prose('diagnostic accuracy reporting', 300))],
            [para(prose('the reporting guideline items', 300))],
            [heading('Abstract'), para(prose('a checklist row about abstracts', 60))],
        ]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.bodySource).toBe('opening');
        expect(result.body).toContain('diagnostic accuracy reporting');
    });

    it('skips repository cover sheets and finds the abstract behind them', () => {
        const doc = pdf([
            [
                para('The Effect of Employee Treatment Policies on Internal Control Weaknesses'),
                para('JSTOR is a not-for-profit service that helps scholars, researchers, and students discover, use, and build upon a wide range of content.'),
                para('Your use of the JSTOR archive indicates your acceptance of the Terms & Conditions of Use.'),
            ],
            [
                heading('The Effect of Employee Treatment Policies on Internal Control Weaknesses'),
                para(`ABSTRACT: ${prose('employment policies and internal control', 60)}`),
            ],
        ]);

        const result = deriveEmbeddingText({
            contentKind: 'pdf',
            document: doc,
            pdfTitle: 'The Effect of Employee Treatment Policies on Internal Control Weaknesses',
        });

        expect(result.bodySource).toBe('abstract');
        expect(result.body).toContain('employment policies and internal control');
        expect(result.body).not.toContain('JSTOR');
        expect(result.titleSource).toBe('pdf_metadata');
    });

    it('falls back to opening prose without author, affiliation or license blocks', () => {
        const doc = pdf([[
            heading('Street Children and Public Health'),
            para('Jane Smith, Robert Brown, Alice Walker, Thomas Green, Mary Johnson'),
            para('1 Department of Sociology, University of Somewhere, Somewhere City, Country'),
            para('© 2020 The Authors. Published under a Creative Commons license. All rights reserved.'),
            para(prose('street children in developing countries')),
            para(prose('homelessness in industrialized nations', 40)),
        ]]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.bodySource).toBe('opening');
        expect(result.body.startsWith('This study examines street children')).toBe(true);
        expect(result.body).toContain('homelessness in industrialized nations');
        expect(result.body).not.toMatch(/University|Creative Commons|Jane Smith/);
    });

    it('starts the opening at the first paragraph below the title on multi-column pages', () => {
        const doc = pdf([[
            // Reading order puts a right-column paragraph first.
            para(`The polymerase core ${prose('the right column fragment', 60)}`, [320, 60, 560, 300]),
            heading('In-cell architecture of an expressome', [40, 60, 300, 90]),
            para(prose('the abstract under the title', 60), [40, 120, 300, 360]),
            para(`continued text ${prose('the second column', 40)}`, [320, 320, 560, 500]),
        ]]);

        const result = deriveEmbeddingText(
            { contentKind: 'pdf', document: doc },
            { title: 'In-cell architecture of an expressome' },
        );

        expect(result.bodySource).toBe('opening');
        expect(result.body.startsWith('This study examines the abstract under the title')).toBe(true);
        expect(result.titleSource).toBe('provided');
    });

    it('survives malformed character references in PDF metadata titles', () => {
        const doc = pdf([[
            heading('Kinesin motors in cilia', [50, 80, 550, 150]),
            para(prose('kinesin motors in cilia'), [50, 200, 550, 400]),
        ]]);

        for (const pdfTitle of ['Kinesin &#x110000; motors', 'Kinesin &#99999999; motors', 'Kinesin &#xD800; motors']) {
            const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc, pdfTitle });
            expect(result.bodySource).toBe('opening');
            expect(result.body).toContain('kinesin motors in cilia');
        }
        const decoded = deriveEmbeddingText({ contentKind: 'pdf', document: doc, pdfTitle: 'Kinesin motors in cilia &#x2014; &#38; more' });
        expect(decoded.title).toBe('Kinesin motors in cilia — & more');
    });

    it('rejects implausible PDF metadata titles and uses the largest title-like text', () => {
        const doc = pdf([[
            heading('Journal of Cell Science', [50, 40, 250, 52]),
            heading('Kif9 is an active kinesin motor required for ciliary beating', [50, 80, 550, 150]),
            para('Jane Doe1,2, John Roe1*', [50, 160, 400, 172]),
            para(prose('kinesin motors in cilia'), [50, 200, 550, 400]),
        ]]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc, pdfTitle: 'ELIFE05864 1..20' });

        expect(result.titleSource).toBe('document');
        expect(result.title).toBe('Kif9 is an active kinesin motor required for ciliary beating');
    });

    it('recognizes CJK abstract and keyword labels and measures CJK text by characters', () => {
        const abstract = '现代性作为现代世界之本质的根据，包含两个基本支柱，即资本和现代形而上学。'.repeat(4);
        const doc = pdf([[
            heading('论马克思对现代性的双重批判'),
            para(`［摘 要］${abstract}`),
            para('［关键词］现代性 资本 现代形而上学 双重批判'),
        ]]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.bodySource).toBe('abstract');
        expect(result.body).toBe(abstract);
        expect(result.keywords).toBe('现代性 资本 现代形而上学 双重批判');
    });

    it('keeps prose in scripts without letter case', () => {
        const korean = '이 연구는 도시 지역의 주거 이동이 청소년의 학업 성취에 미치는 영향을 분석한다. '
            + '전국 패널 자료를 이용하여 이사 횟수와 학교 전환이 성적에 미치는 효과를 추정하였다. '
            + '분석 결과 잦은 이사는 수학과 읽기 성취를 모두 낮추는 것으로 나타났다. '
            + '이러한 효과는 저소득 가정의 학생들에게서 더 크게 나타났다. '
            + '이 결과는 주거 안정 정책이 교육 격차를 줄이는 데 기여할 수 있음을 시사한다.';
        const snapshot = dom([{ label: '주거 이동과 학업 성취', items: [
            ['section_header', '초록'],
            ['text', korean],
        ] }]);
        const opening = dom([{ label: '주거 이동과 학업 성취', items: [['text', korean]] }]);
        const hindi = 'यह अध्ययन शहरी क्षेत्रों में आवास गतिशीलता और छात्रों की शैक्षणिक उपलब्धि के बीच संबंध का विश्लेषण करता है। '.repeat(8);

        const fromAbstract = deriveEmbeddingText({ contentKind: 'snapshot', document: snapshot });
        const fromOpening = deriveEmbeddingText({ contentKind: 'snapshot', document: opening });
        const fromHindi = deriveEmbeddingText({ contentKind: 'snapshot', document: dom([{ items: [['text', hindi]] }]) });

        expect(fromAbstract.bodySource).toBe('abstract');
        expect(fromAbstract.body).toBe(korean);
        expect(fromOpening.bodySource).toBe('opening');
        expect(fromOpening.body).toBe(korean);
        expect(fromHindi.bodySource).toBe('opening');
    });

    it('skips EPUB front matter sections before the introduction', () => {
        const doc = dom([
            { label: 'Cover Page', items: [] },
            { label: 'Engineering Manhood', items: [
                ['text', 'Copyright © 2020 Lever Press. All rights reserved. Library of Congress Cataloging-in-Publication Data. ISBN 978-1-64315-000-0. Printed in the United States of America.'],
            ] },
            { label: 'Engineering Manhood', items: [
                ['section_header', 'Contents'],
                ['text', 'Introduction 1'], ['text', 'Chapter One 25'], ['text', 'Chapter Two 41'],
            ] },
            { label: 'Engineering Manhood', items: [
                ['section_header', 'Page 1 →Introduction'],
                ['text', prose('engineering education in antebellum Virginia')],
            ] },
        ]);

        const result = deriveEmbeddingText({ contentKind: 'epub', document: doc });

        expect(result.title).toBe('Engineering Manhood');
        expect(result.bodySource).toBe('opening');
        expect(result.body.startsWith('This study examines engineering education')).toBe(true);
    });

    it('keeps single-word EPUB and web page titles', () => {
        const epub = dom([{ label: 'Frankenstein', items: [['text', prose('the creation of life')]] }]);
        const snapshot = dom([{ label: '1984', items: [['text', prose('surveillance and totalitarian rule')]] }]);

        expect(deriveEmbeddingText({ contentKind: 'epub', document: epub }).title).toBe('Frankenstein');
        expect(deriveEmbeddingText({ contentKind: 'snapshot', document: snapshot }).title).toBe('1984');
    });

    it('ignores file names and identifiers as EPUB titles', () => {
        const doc = dom([
            { label: 'chapter01.xhtml', items: [] },
            { label: 'OEBPS_Text', items: [] },
            { label: '9780820318370', items: [['text', prose('reconstruction politics')]] },
        ]);

        expect(deriveEmbeddingText({ contentKind: 'epub', document: doc }).title).toBeNull();
    });

    it('keeps the article that follows a table of contents in the same section', () => {
        const snapshot = dom([{ label: 'A Guide to Network Analysis', items: [
            ['section_header', 'Contents'],
            ['list_item', 'Introduction'],
            ['list_item', 'Methods'],
            ['section_header', 'Introduction'],
            ['text', prose('network analysis in the humanities')],
        ] }]);
        const epub = dom([{ label: 'A Book', items: [
            ['section_header', 'Contents'],
            ['text', 'Introduction 1'], ['text', 'Chapter One 25'],
            ['section_header', 'Introduction'],
            ['text', prose('the history of the book')],
        ] }]);

        const fromSnapshot = deriveEmbeddingText({ contentKind: 'snapshot', document: snapshot });
        const fromEpub = deriveEmbeddingText({ contentKind: 'epub', document: epub });

        expect(fromSnapshot.bodySource).toBe('opening');
        expect(fromSnapshot.body).toContain('network analysis in the humanities');
        expect(fromEpub.body).toContain('the history of the book');
    });

    it('ends a mid-page contents box at the next paragraph', () => {
        const doc = pdf([[
            heading('Biopolymer nanofibrils: structure and applications'),
            heading('Contents'),
            para('1. Introduction 2'),
            para('2. Structure 5'),
            para(prose('the mechanical properties of biopolymer nanofibrils')),
        ]]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.body).toContain('the mechanical properties of biopolymer nanofibrils');
    });

    it('skips a contents page whose entries are set as headings', () => {
        const doc = pdf([
            [heading('CONTENTS'), heading('10 INTRODUCTION'), heading('THE ANCIENT WORLD'), heading('22 Everything is made of water')],
            [heading('INTRODUCTION'), para(prose('why philosophy matters for everyday life'))],
        ]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc }, { maxPages: 1 });

        expect(result.body).toContain('why philosophy matters for everyday life');
    });

    it('returns no body for web pages that only contain navigation', () => {
        const doc = dom([{ label: 'SpringerLink - Abstract', items: [
            ['list_item', 'Skip to Main Content'],
            ['list_item', 'Log In or Out'],
            ['list_item', 'Advanced Search'],
            ['text', 'Browse by Discipline'],
        ] }]);

        const result = deriveEmbeddingText({ contentKind: 'snapshot', document: doc });

        expect(result.bodySource).toBe('none');
        expect(result.body).toBe('');
        expect(result.text).toBe('SpringerLink - Abstract');
    });

    it('uses the article heading inside a web page title without the site name', () => {
        const doc = dom([{ label: 'Bias Persists Against Women of Science, a Study Says - NYTimes.com', items: [
            ['section_header', 'Bias Persists Against Women of Science, a Study Says'],
            ['text', prose('gender bias among science faculty')],
        ] }]);

        const result = deriveEmbeddingText({ contentKind: 'snapshot', document: doc });

        expect(result.title).toBe('Bias Persists Against Women of Science, a Study Says');
        expect(result.bodySource).toBe('opening');
    });

    it('builds an outline for slide decks without running prose', () => {
        const doc = pdf([
            [heading('The Relationships Between Topics in Defense Acquisition')],
            [heading('Strategy, ends, ways and means'), para('Warfighters and combatant commands')],
            [heading('Acquisition programs'), para('Military services provide capabilities')],
        ]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.bodySource).toBe('outline');
        expect(result.body).toContain('Acquisition programs');
    });

    it('strips manuscript line numbers that run down the page', () => {
        const line = (n: number, words: string) => `${n} ${words}`;
        const first = [
            line(12, 'Climate services are high in the international agenda for their potential to help combat the'),
            line(13, 'effects of climate change. However, climate science is rarely directly incorporated in the'),
            line(14, 'decision-making processes of public and private organizations across many sectors of society.'),
            line(15, 'Co-production with users is widely recommended as a way to make climate information usable.'),
        ].join(' ');
        const second = [
            line(16, 'In this paper we review how users are selected and engaged in co-production processes and we'),
            line(17, 'identify the main barriers that limit engagement across the different stages of service design.'),
            line(18, 'We find that the lack of guidance for consistent user selection is more important than the lack'),
            line(19, 'of willingness of scientists and users to engage with each other in the co-production process.'),
        ].join(' ');
        const result = deriveEmbeddingText({ contentKind: 'pdf', document: pdf([[para(first), para(second)]]) });

        expect(result.body).toContain('to help combat the effects of climate change');
        expect(result.body).toContain('in co-production processes and we identify the main barriers');
        expect(result.body).not.toMatch(/\b1\d\b/);
    });

    it('keeps a few consecutive counts even when spaced like lines', () => {
        const counts = 'In the first phase of the trial we assigned 12 participants to the standard reading programme. '
            + 'In the second phase of the trial we assigned 13 participants to the enriched reading programme. '
            + 'In the third phase of the trial we assigned 14 participants to a waiting-list control group. '
            + prose('reading programmes for struggling readers', 40);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: pdf([[para(counts)]]) });

        expect(result.body).toContain('assigned 12 participants');
        expect(result.body).toContain('assigned 13 participants');
        expect(result.body).toContain('assigned 14 participants');
    });

    it('does not extend numbered affiliation lists into the abstract', () => {
        const affiliations = Array.from({ length: 8 }, (_, i) => `${i + 1} Department of Medicine, University Hospital ${i + 1}, City, Country`);
        const doc = pdf([[
            ...affiliations.map((text) => para(text)),
            heading('Abstract'),
            para(`Variants in this gene cause diabetes, collectively affecting up to 10 million people worldwide. ${prose('glucokinase variant activity', 40)}`),
        ]]);

        const result = deriveEmbeddingText({ contentKind: 'pdf', document: doc });

        expect(result.body).toContain('affecting up to 10 million people');
    });

    it('keeps consecutive numbers that are part of the prose', () => {
        const years = 'We surveyed the same households during 2020 and again during 2021 and 2022 to identify changes in '
            + 'employment. ' + prose('household employment during the pandemic', 40);
        const grades = 'Students in grades 3 4 and 5 completed the reading assessment at the end of the school year. '
            + prose('reading achievement in primary school', 40);

        const yearResult = deriveEmbeddingText({ contentKind: 'pdf', document: pdf([[para(years)]]) });
        const gradeResult = deriveEmbeddingText({ contentKind: 'pdf', document: pdf([[para(grades)]]) });

        expect(yearResult.body).toContain('during 2020 and again during 2021 and 2022');
        expect(gradeResult.body).toContain('grades 3 4 and 5');
    });

    it('does not remove numbers from EPUB text or provided titles', () => {
        const text = 'Chapters 10 11 and 12 revisit the argument. ' + prose('the argument of the book', 40);
        const epub = dom([{ label: 'A Book', items: [['text', text]] }]);

        const result = deriveEmbeddingText({ contentKind: 'epub', document: epub }, { title: 'Lessons 1 2 3 of Ethics' });

        expect(result.body).toContain('Chapters 10 11 and 12');
        expect(result.title).toBe('Lessons 1 2 3 of Ethics');
    });

    it('keeps the body within budget and cuts at a sentence boundary', () => {
        const result = deriveEmbeddingText(
            { contentKind: 'pdf', document: pdf([[para(prose('a long topic', 600))]]) },
            { maxBodyChars: 500 },
        );

        expect(result.body.length).toBeLessThanOrEqual(500);
        expect(result.body.endsWith('.')).toBe(true);
    });
});

describe('isUsableEmbeddingBody', () => {
    const usable = (body: string, bodySource: 'abstract' | 'opening' | 'outline' = 'opening', extractionSource: 'native' | 'ocr' = 'native') =>
        isUsableEmbeddingBody({ body, bodySource, extractionSource });

    const vietnamese = 'Nghiên cứu này xem xét điều kiện khu phố ảnh hưởng đến kết quả giáo dục của trẻ em như thế nào.';
    const korean = '본 논문에서는 한국어 자연어 처리 작업에 적용되는 사전 학습 언어 모델의 성능을 평가한다.';
    it.each([
        ['English', prose('neighborhood effects on schooling')],
        ['German', 'Die Apokalypse des Johannes war und ist bis heute sicherlich kein leicht zu gebrauchendes Buch.'],
        ['Turkish', 'Bu çalışma, mahalle koşullarının çocukların eğitim sonuçlarını nasıl şekillendirdiğini incelemektedir.'],
        ['Vietnamese', vietnamese],
        ['Vietnamese (NFD)', vietnamese.normalize('NFD')],
        ['Greek', 'Η μελέτη αυτή εξετάζει πώς οι συνθήκες της γειτονιάς διαμορφώνουν τα εκπαιδευτικά αποτελέσματα.'],
        ['Russian', 'В данной работе рассматривается влияние условий района на образовательные результаты детей.'],
        ['Arabic', 'تتناول هذه الدراسة كيفية تأثير ظروف الحي على النتائج التعليمية للأطفال عبر العقود.'],
        ['Arabic with harakat', 'تَتَنَاوَلُ هَذِهِ الدِّرَاسَةُ كَيْفِيَّةَ تَأْثِيرِ ظُرُوفِ الحَيِّ عَلَى النَّتَائِجِ التَّعْلِيمِيَّةِ لِلْأَطْفَالِ.'],
        ['Hebrew with niqqud', 'בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ וְהָאָרֶץ הָיְתָה תֹהוּ וָבֹהוּ.'],
        ['Persian', 'این پژوهش بررسی می‌کند که شرایط محله چگونه بر نتایج آموزشی کودکان اثر می‌گذارد.'],
        ['Hindi', 'इस शोध पत्र में हम हिंदी भाषा के स्वचालित संसाधन के लिए उपलब्ध तकनीकों का अध्ययन प्रस्तुत करते हैं।'],
        ['Bengali', 'এই গবেষণায় আমরা বাংলা ভাষার স্বয়ংক্রিয় প্রক্রিয়াকরণের কৌশলগুলি পর্যালোচনা করি।'],
        ['Tamil', 'தமிழ் மொழியில் இயற்கை மொழிச் செயலாக்கம் குறித்த ஆய்வுகள் முக்கியத்துவம் பெறுகின்றன.'],
        ['Telugu', 'ఈ పరిశోధనలో తెలుగు భాష యొక్క సహజ భాషా ప్రక్రియను మేము అధ్యయనం చేస్తాము.'],
        ['Kannada', 'ಈ ಸಂಶೋಧನೆಯಲ್ಲಿ ನಾವು ಕನ್ನಡ ಭಾಷೆಯ ಸ್ವಯಂಚಾಲಿತ ಸಂಸ್ಕರಣೆಯನ್ನು ಅಧ್ಯಯನ ಮಾಡುತ್ತೇವೆ.'],
        ['Malayalam', 'ഈ ഗവേഷണത്തിൽ മലയാള ഭാഷയുടെ സ്വാഭാവിക ഭാഷാ സംസ്കരണം ഞങ്ങൾ പഠിക്കുന്നു.'],
        ['Sinhala', 'මෙම පර්යේෂණයේදී අපි සිංහල භාෂාවේ ස්වභාවික භාෂා සැකසීම අධ්‍යයනය කරමු.'],
        ['Gujarati', 'આ સંશોધનમાં અમે ગુજરાતી ભાષાની સ્વયંસંચાલિત પ્રક્રિયાનો અભ્યાસ કરીએ છીએ.'],
        ['Punjabi', 'ਇਸ ਖੋਜ ਵਿੱਚ ਅਸੀਂ ਪੰਜਾਬੀ ਭਾਸ਼ਾ ਦੀ ਕੁਦਰਤੀ ਪ੍ਰਕਿਰਿਆ ਦਾ ਅਧਿਐਨ ਕਰਦੇ ਹਾਂ।'],
        ['Burmese', 'ဤသုတေသနတွင် မြန်မာဘာသာစကား၏ သဘာဝဘာသာစကားလုပ်ဆောင်ခြင်းကို လေ့လာပါသည်။'],
        ['Thai', 'การประมวลผลภาษาธรรมชาติสำหรับภาษาไทยด้วยโมเดลที่ฝึกฝนล่วงหน้าเป็นหัวข้อสำคัญ'],
        ['Lao', 'ການຄົ້ນຄວ້ານີ້ສຶກສາການປະມວນຜົນພາສາທຳມະຊາດສຳລັບພາສາລາວ'],
        ['Khmer', 'ការស្រាវជ្រាវនេះសិក្សាអំពីដំណើរការភាសាធម្មជាតិសម្រាប់ភាសាខ្មែរ'],
        ['Tibetan', 'འདི་ནི་བོད་ཡིག་གི་རང་བྱུང་སྐད་ཡིག་ལས་སྣོན་སྐོར་གྱི་ཞིབ་འཇུག་ཡིན།'],
        ['Georgian', 'ეს კვლევა იკვლევს, თუ როგორ აყალიბებს სამეზობლოს პირობები ბავშვების განათლების შედეგებს.'],
        ['Armenian', 'Այս ուսումնասիրությունը քննում է, թե ինչպես են թաղամասի պայմանները ձևավորում կրթական արդյունքները։'],
        ['Amharic', 'ይህ ጥናት የሰፈር ሁኔታዎች የልጆችን የትምህርት ውጤቶች እንዴት እንደሚቀርጹ ይመረምራል።'],
        ['Korean', korean],
        ['Korean (NFD)', korean.normalize('NFD')],
        ['Japanese', '本論文では、日本語の自然言語処理タスクにおける事前学習モデルの有効性について検証する。'],
        ['Chinese', '本文研究了预训练语言模型在中文自然语言处理任务中的应用。我们重点关注文本分类。'],
    ])('accepts %s prose', (_language, text) => {
        expect(usable(text)).toBe(true);
    });

    it('accepts an outline of headings from a native PDF', () => {
        expect(usable('Introduction. Methods. Results. Discussion of regional labor markets', 'outline')).toBe(true);
    });

    it('rejects OCR noise, form fields and outlines of OCR scans', () => {
        const receipt = 'WELCOME 15. OUR STORE. LONG WHARF. MOBIL. , CT ee | 4 sexPRE- AUTHORIZED RECEIPT ke. mp '
            + '<CUSTOMER CoPY>. PREPAY CR #06 _s 25.00. Subtotal > 25.00 Tax 0.00. TOTAL 25 -00. PREAUTH $ 25.00. '
            + 'Acct/Card #: x cccckexax%9503. Invoice #: 69688 Shift #291. TERMINAL 1D: 001 a. ae aoooo00004 1010';
        expect(usable(receipt, 'opening', 'ocr')).toBe(false);
        expect(usable('12 34 56 78 90 11 22 33 44 55 66 77 88 99 10 20 30 40 50 60')).toBe(false);
        expect(usable('SUBTOTAL TAX TOTAL CASH CHANGE VISA APPROVED TERMINAL STORE MERCHANT INVOICE RECEIPT')).toBe(false);
        expect(usable('Chapter one. Our approach. The data we collected', 'outline', 'ocr')).toBe(false);
        expect(usable('', 'abstract')).toBe(false);
        expect(isUsableEmbeddingBody({ body: 'Some text', bodySource: 'none', extractionSource: 'native' })).toBe(false);
    });
});
