/**
 * Unit tests for `LanguageDetector` — the pure text language detector
 * used by the sentence-extraction pipeline.
 *
 * These tests exercise the deterministic logic (sparseness gate, script
 * short-circuits, allowlist gate, fallback chain). The eld classifier
 * itself is invoked directly because it is pure JS with no native deps;
 * the runtime cost is small (~10 ms cold start).
 */

import { describe, it, expect } from 'vitest';
import {
    detectLanguageFromText,
    SENTENCEX_ACCEPTED_DETECTED_LANGUAGES,
} from '../../../src/services/pdf/LanguageDetector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPEAT = (s: string, n: number): string => {
    let out = '';
    for (let i = 0; i < n; i++) out += s + ' ';
    return out;
};

// English paragraph long enough to clear the 200-letter gate.
const ENGLISH_SAMPLE =
    'The quick brown fox jumps over the lazy dog. ' +
    'A wonderful serenity has taken possession of my entire soul, like ' +
    'these sweet mornings of spring which I enjoy with my whole heart. ' +
    'I am alone, and feel the charm of existence in this spot, which was ' +
    'created for the bliss of souls like mine. So happy am I, my dear friend, ' +
    'so absorbed in the exquisite sense of mere tranquil existence, that I ' +
    'neglect my talents.';

const GERMAN_SAMPLE =
    'Es war einmal ein König, der hatte drei Söhne, von denen waren die zwei ' +
    'ältesten klug und gescheit, der jüngste aber wurde der Dummling genannt. ' +
    'Als der König alt und schwach wurde und an sein Ende dachte, wußte er ' +
    'nicht, welcher von seinen Söhnen das Reich erben sollte. Da sprach er ' +
    'zu ihnen: „Zieht aus, und wer mir den feinsten Teppich bringt, der soll ' +
    'nach meinem Tod König sein." Damit es aber keinen Streit unter ihnen ' +
    'absetzte, führte er sie vor sein Schloß, blies drei Federn in die Luft ' +
    'und sprach: „Wie die fliegen, so sollt ihr ziehen."';

// Hiragana / Katakana / Kanji mix — long enough to clear the 200-letter gate.
const JAPANESE_SAMPLE = REPEAT(
    'むかしむかし、あるところにおじいさんとおばあさんが住んでいました。' +
        'おじいさんは山へしばかりに、おばあさんは川へせんたくに行きました。' +
        'おばあさんが川でせんたくをしていると、川上から大きな桃がドンブラコ、ドンブラコと流れてきました。' +
        'おばあさんはその桃を拾い上げ、家に持ち帰っておじいさんと一緒に食べようとしました。',
    2,
);

// Mixed Japanese + English abstract — the academic-PDF case. Han + kana
// is well under 85% of letters here (~50%) but well over 30%, and kana
// dominates the CJK subset.
const JAPANESE_WITH_EN_ABSTRACT_SAMPLE =
    'Abstract: This paper investigates pre-trained language models for Japanese ' +
    'natural language processing tasks including text classification, named ' +
    'entity recognition, and question answering, with extensive evaluation on ' +
    'multiple public benchmarks across several real-world domains. ' +
    '本論文では、日本語の自然言語処理タスクにおける事前学習モデルの応用について検討します。' +
    'テキスト分類、固有表現認識、質問応答の三つの主要タスクを取り上げ、複数のデータセットで性能を評価しました。' +
    '実験結果は、大規模日本語コーパスで事前学習されたモデルが従来の手法を大きく上回ることを示しています。';

// Pure Han (no kana) — a Chinese paragraph repeated to clear the gate.
const CHINESE_SAMPLE = REPEAT(
    '从前有一座山，山里有一座庙，庙里有一个老和尚和一个小和尚。' +
        '老和尚每天都给小和尚讲故事，从前有一座山，山里有一座庙，庙里有一个老和尚和一个小和尚。' +
        '小和尚听得入神，每次都问师父这个故事什么时候讲完，老和尚总是笑而不答。' +
        '日复一日，年复一年，小和尚渐渐长大，终于明白这个故事永远没有结束的一天。',
    2,
);

// Mixed Chinese + English abstract — academic PDF case.
const CHINESE_WITH_EN_ABSTRACT_SAMPLE =
    'Abstract: This paper investigates the application of pre-trained language models ' +
    'to Chinese natural language processing tasks, including text classification, ' +
    'named entity recognition, and question answering, with extensive empirical evaluation. ' +
    '本文研究了预训练语言模型在中文自然语言处理任务中的应用。' +
    '我们重点关注文本分类、命名实体识别以及问答系统三个核心任务。' +
    '实验结果表明，基于大规模中文语料预训练的模型在各项任务上均取得了显著提升。';

// Hangul-only Korean paragraph repeated.
const KOREAN_SAMPLE = REPEAT(
    '옛날 옛적에 한 임금님이 있었는데 그에게는 세 아들이 있었습니다. ' +
        '첫째와 둘째는 똑똑하고 영리했지만 막내는 어리석다고 모두가 놀렸습니다. ' +
        '왕이 늙고 병들어 후계자를 정해야 할 때가 왔을 때 그는 누가 왕국을 ' +
        '물려받을 자격이 있는지 알 수 없었습니다. 그래서 왕은 세 아들에게 ' +
        '가장 아름다운 양탄자를 가져오는 자가 다음 왕이 될 것이라고 말했습니다.',
    2,
);

// Cyrillic Russian with English abstract — exercises the strip-Latin path.
const RUSSIAN_WITH_EN_ABSTRACT_SAMPLE =
    'Abstract: This paper investigates the application of machine learning methods ' +
    'in the analysis of scientific publications, with particular attention to ' +
    'citation graphs and topic modelling on extensive evaluation datasets. ' +
    'Жили-были старик со старухой у самого синего моря; они жили в ветхой землянке ' +
    'ровно тридцать лет и три года. Старик ловил неводом рыбу, старуха пряла свою ' +
    'пряжу. Раз он в море закинул невод — пришёл невод с одною тиной.';

// Cyrillic Russian — must go through eld, not a script short-circuit.
const RUSSIAN_SAMPLE =
    'Жили-были старик со старухой у самого синего моря; они жили в ветхой ' +
    'землянке ровно тридцать лет и три года. Старик ловил неводом рыбу, ' +
    'старуха пряла свою пряжу. Раз он в море закинул невод — пришёл невод ' +
    'с одною тиной. Он в другой раз закинул невод — пришёл невод с травою ' +
    'морскою. В третий раз закинул он невод — пришёл невод с одною рыбкой, ' +
    'с непростою рыбкой — золотою.';

// Cyrillic Ukrainian.
const UKRAINIAN_SAMPLE =
    'Якось наприкінці літа, коли вже починалися перші холодні ночі, ' +
    'старий рибалка вирушив до моря, як це робив щодня впродовж довгих років. ' +
    'Він закинув свою сітку у глибоку воду й чекав, доки риба запливе всередину. ' +
    'Цього разу йому пощастило: у сітці заплуталася золота рибка, яка вміла ' +
    'розмовляти людською мовою і просила його про допомогу.';

// ---------------------------------------------------------------------------
// Sparseness gate
// ---------------------------------------------------------------------------

describe('detectLanguageFromText: sparse input', () => {
    it('returns default "en" when the sample has no letters and no fallback', async () => {
        const r = await detectLanguageFromText('');
        expect(r).toEqual({ language: 'en', source: 'default' });
    });

    it('returns fallback (normalized) when the sample is too short', async () => {
        const r = await detectLanguageFromText('hi', { fallback: 'de' });
        expect(r).toEqual({ language: 'de', source: 'fallback' });
    });

    it('normalizes free-text fallback values (English name → ISO 639-1)', async () => {
        const r = await detectLanguageFromText('   ', { fallback: 'German' });
        expect(r).toEqual({ language: 'de', source: 'fallback' });
    });

    it('normalizes BCP-47 fallback codes', async () => {
        const r = await detectLanguageFromText('', { fallback: 'en-US' });
        expect(r).toEqual({ language: 'en', source: 'fallback' });
    });
});

// ---------------------------------------------------------------------------
// Script short-circuits — must NOT call eld
// ---------------------------------------------------------------------------

describe('detectLanguageFromText: Unicode script short-circuits', () => {
    it('Japanese (Hiragana/Katakana + Kanji) → ja via "script"', async () => {
        const r = await detectLanguageFromText(JAPANESE_SAMPLE);
        expect(r).toEqual({ language: 'ja', source: 'script' });
    });

    it('Pure Han (no kana) → zh via "script"', async () => {
        const r = await detectLanguageFromText(CHINESE_SAMPLE);
        expect(r).toEqual({ language: 'zh', source: 'script' });
    });

    it('Hangul → ko via "script"', async () => {
        const r = await detectLanguageFromText(KOREAN_SAMPLE);
        expect(r).toEqual({ language: 'ko', source: 'script' });
    });

    it('Cyrillic does NOT short-circuit (defers to eld for ru/uk/etc)', async () => {
        const r = await detectLanguageFromText(RUSSIAN_SAMPLE);
        expect(r.source).not.toBe('script');
    });

    it('Japanese with English abstract still resolves to ja (academic-PDF case)', async () => {
        const r = await detectLanguageFromText(JAPANESE_WITH_EN_ABSTRACT_SAMPLE);
        expect(r).toEqual({ language: 'ja', source: 'script' });
    });

    it('Chinese with English abstract still resolves to zh (academic-PDF case)', async () => {
        const r = await detectLanguageFromText(CHINESE_WITH_EN_ABSTRACT_SAMPLE);
        expect(r).toEqual({ language: 'zh', source: 'script' });
    });
});

// ---------------------------------------------------------------------------
// eld classifier
// ---------------------------------------------------------------------------

describe('detectLanguageFromText: eld classifier', () => {
    it('detects English via eld', async () => {
        const r = await detectLanguageFromText(ENGLISH_SAMPLE);
        expect(r).toEqual({ language: 'en', source: 'eld' });
    });

    it('detects German via eld', async () => {
        const r = await detectLanguageFromText(GERMAN_SAMPLE);
        expect(r).toEqual({ language: 'de', source: 'eld' });
    });

    it('detects Russian (Cyrillic) via eld', async () => {
        const r = await detectLanguageFromText(RUSSIAN_SAMPLE);
        expect(r).toEqual({ language: 'ru', source: 'eld' });
    });

    it('detects Ukrainian (Cyrillic) via eld', async () => {
        const r = await detectLanguageFromText(UKRAINIAN_SAMPLE);
        // eld may or may not distinguish ru/uk on a small sample; accept
        // whichever it produces, but assert it's in the Cyrillic family.
        expect(r.source).toBe('eld');
        expect(['ru', 'uk']).toContain(r.language);
    });

    it('Russian with English abstract: strip-Latin path keeps eld on Cyrillic', async () => {
        const r = await detectLanguageFromText(RUSSIAN_WITH_EN_ABSTRACT_SAMPLE);
        expect(r.source).toBe('eld');
        // Without the strip, eld would see ~50% Latin and pick "en". With
        // the strip, only Cyrillic survives → ru/uk family.
        expect(['ru', 'uk']).toContain(r.language);
    });
});

// ---------------------------------------------------------------------------
// Allowlist gate + fallback chain
// ---------------------------------------------------------------------------

describe('detectLanguageFromText: allowlist gate', () => {
    it('rejects detected codes outside the allowlist (Lao → fallback)', async () => {
        // Lao text — eld supports `lo` but it is intentionally not in
        // SENTENCEX_ACCEPTED_DETECTED_LANGUAGES.
        const lao = REPEAT(
            'ໃນສະໄຫມຫນຶ່ງ ມີຊາຍແກ່ຄົນຫນຶ່ງອາໄສຢູ່ໃນປ່າ ' +
                'ລາວເປັນຄົນດີໃຈກວ້າງ ມີຄວາມເມດຕາຕໍ່ສັດປ່າ',
            3,
        );
        const r = await detectLanguageFromText(lao, { fallback: 'en' });
        // Either eld didn't detect (defaults), or detected `lo` and was
        // gated. Both should land at fallback / default → 'en'.
        expect(r.language).toBe('en');
        expect(['fallback', 'default']).toContain(r.source);
    });

    it('Indonesian text is detected as Malay (ms), which is not in the allowlist → fallback', async () => {
        const indonesian =
            'Pada zaman dahulu kala hiduplah seorang raja yang sangat bijaksana ' +
            'di sebuah kerajaan kecil. Raja ini memiliki tiga orang putra yang ' +
            'sangat ia cintai dengan segenap hatinya. Ketika usianya semakin tua ' +
            'dan kesehatannya menurun, raja mulai memikirkan siapa di antara ' +
            'putranya yang akan mewarisi takhta kerajaan ini setelah kepergiannya.';
        const r = await detectLanguageFromText(indonesian, { fallback: 'en' });
        // Either detected → ms (not allowlisted) → fallback,
        // or didn't detect cleanly → default fallback.
        expect(['fallback', 'default']).toContain(r.source);
        expect(r.language).toBe('en');
    });
});

// ---------------------------------------------------------------------------
// Allowlist composition
// ---------------------------------------------------------------------------

describe('SENTENCEX_ACCEPTED_DETECTED_LANGUAGES', () => {
    it('contains the highest-volume codes', () => {
        for (const code of ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh', 'ru', 'uk']) {
            expect(SENTENCEX_ACCEPTED_DETECTED_LANGUAGES.has(code)).toBe(true);
        }
    });

    it('does NOT include Indonesian (eld returns `ms` for Indonesian text)', () => {
        expect(SENTENCEX_ACCEPTED_DETECTED_LANGUAGES.has('id')).toBe(false);
    });
});
