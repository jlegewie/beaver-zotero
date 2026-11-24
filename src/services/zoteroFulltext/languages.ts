/**
 * Languages of a library's items, for asking the agent (or the server-side
 * keyword expansion) for search terms in those languages.
 *
 * Zotero's free-text `language` field is mapped to ISO 639-1 codes. Items
 * without one are classified by the script of their title when that script
 * names a language unambiguously (CJK, Cyrillic, Greek, Arabic, Hebrew).
 */

const NAMES: Record<string, string> = {
    english: 'en', eng: 'en', englisch: 'en', anglais: 'en', ingles: 'en', inglese: 'en',
    german: 'de', deutsch: 'de', ger: 'de', deu: 'de', allemand: 'de', aleman: 'de', tedesco: 'de',
    french: 'fr', francais: 'fr', fre: 'fr', fra: 'fr', franzosisch: 'fr', frances: 'fr', francese: 'fr',
    spanish: 'es', espanol: 'es', castellano: 'es', spa: 'es', spanisch: 'es', espagnol: 'es', spagnolo: 'es',
    portuguese: 'pt', portugues: 'pt', por: 'pt', portugiesisch: 'pt',
    italian: 'it', italiano: 'it', ita: 'it', italienisch: 'it', italien: 'it',
    dutch: 'nl', nederlands: 'nl', dut: 'nl', nld: 'nl', niederlandisch: 'nl',
    chinese: 'zh', chi: 'zh', zho: 'zh', '中文': 'zh', '汉语': 'zh', '漢語': 'zh', '简体中文': 'zh', '繁體中文': 'zh', '英文': 'en',
    japanese: 'ja', jpn: 'ja', '日本語': 'ja',
    korean: 'ko', kor: 'ko', '한국어': 'ko',
    russian: 'ru', rus: 'ru', 'русский': 'ru',
    polish: 'pl', polski: 'pl', pol: 'pl',
    swedish: 'sv', svenska: 'sv', swe: 'sv',
    danish: 'da', dansk: 'da', dan: 'da',
    norwegian: 'no', norsk: 'no', nor: 'no', nob: 'no', nno: 'no',
    finnish: 'fi', suomi: 'fi', fin: 'fi',
    turkish: 'tr', turkce: 'tr', tur: 'tr',
    arabic: 'ar', ara: 'ar',
    hebrew: 'he', heb: 'he',
    greek: 'el', gre: 'el', ell: 'el',
    czech: 'cs', cze: 'cs', ces: 'cs', cestina: 'cs',
    hungarian: 'hu', magyar: 'hu', hun: 'hu',
    latin: 'la', lat: 'la',
    catalan: 'ca', catala: 'ca', cat: 'ca',
    persian: 'fa', farsi: 'fa', per: 'fa', fas: 'fa',
    ukrainian: 'uk', ukr: 'uk',
    vietnamese: 'vi', vie: 'vi',
    indonesian: 'id', ind: 'id',
};

/** ISO 639-1 code for a Zotero `language` value, or null when it can't be read. */
export function languageCode(value: string | null | undefined): string | null {
    if (!value) return null;
    const folded = value.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
    if (!folded) return null;
    if (NAMES[folded]) return NAMES[folded];
    const first = folded.split(/[\s,;/_-]+/)[0];
    if (NAMES[first]) return NAMES[first];
    if (/^[a-z]{2}$/.test(first)) return first;
    return null;
}

/** Language implied by the script of a title, when the script names one language. */
export function scriptLanguage(title: string | null | undefined): string | null {
    if (!title) return null;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title)) return 'ja';
    if (/\p{Script=Hangul}/u.test(title)) return 'ko';
    if (/\p{Script=Han}/u.test(title)) return 'zh';
    if (/\p{Script=Cyrillic}/u.test(title)) return 'ru';
    if (/\p{Script=Greek}{3,}/u.test(title)) return 'el';
    if (/\p{Script=Arabic}/u.test(title)) return 'ar';
    if (/\p{Script=Hebrew}/u.test(title)) return 'he';
    return null;
}

/** A language needs this share of the classified items, and this many items, to be reported. */
const MIN_SHARE = 0.05;
const MIN_ITEMS = 5;
const MAX_LANGUAGES = 5;

/** Codes that make up a noticeable share of `counts`, most common first. */
export function prominentLanguages(counts: ReadonlyMap<string, number>): string[] {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    if (!total) return [];
    return [...counts.entries()]
        .filter(([, n]) => n >= MIN_ITEMS && n / total >= MIN_SHARE)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_LANGUAGES)
        .map(([code]) => code);
}

/** Count item languages across regular items of the given libraries. */
export async function countLibraryLanguages(libraryIds: number[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!libraryIds.length) return counts;
    const languageField = Zotero.ItemFields.getID('language');
    const titleField = Zotero.ItemFields.getID('title');
    if (!languageField || !titleField) return counts;
    const placeholders = libraryIds.map(() => '?').join(',');
    await Zotero.DB.queryAsync(
        `SELECT LV.value, TV.value
         FROM items I
         LEFT JOIN itemData LD ON LD.itemID = I.itemID AND LD.fieldID = ?
         LEFT JOIN itemDataValues LV ON LV.valueID = LD.valueID
         LEFT JOIN itemData TD ON TD.itemID = I.itemID AND TD.fieldID = ?
         LEFT JOIN itemDataValues TV ON TV.valueID = TD.valueID
         WHERE I.libraryID IN (${placeholders})
           AND I.itemID NOT IN (SELECT itemID FROM itemAttachments)
           AND I.itemID NOT IN (SELECT itemID FROM itemNotes)
           AND I.itemID NOT IN (SELECT itemID FROM itemAnnotations)
           AND NOT EXISTS (SELECT 1 FROM deletedItems D WHERE D.itemID = I.itemID)`,
        [languageField, titleField, ...libraryIds],
        {
            onRow: (row: any) => {
                const code = languageCode(row.getResultByIndex(0)) ?? scriptLanguage(row.getResultByIndex(1));
                if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
            },
        },
    );
    return counts;
}
