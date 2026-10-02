import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeItemJson, normalizeTags } from '../../../src/services/itemImport/itemJson';

/**
 * A stand-in for Zotero.Item.fromJSON/toJSON in non-strict mode: fields the
 * item type does not hold move into Extra, roles the type does not allow
 * become "author", and identity keys are added on output.
 */
const TYPE_FIELDS: Record<string, string[]> = {
    journalArticle: ['title', 'DOI', 'date', 'publicationTitle', 'abstractNote', 'extra', 'url'],
    book: ['title', 'ISBN', 'date', 'publisher', 'abstractNote', 'extra'],
};
const TYPE_ROLES: Record<string, string[]> = {
    journalArticle: ['author', 'editor'],
    book: ['author', 'editor'],
};

let lastFromJSON: Record<string, any> | null;
let throwOnFromJSON: Error | null;

class FakeItem {
    libraryID = 0;
    private json: Record<string, any> = {};
    constructor(public itemType: string) {}
    fromJSON(json: Record<string, any>) {
        if (throwOnFromJSON) throw throwOnFromJSON;
        lastFromJSON = JSON.parse(JSON.stringify(json));
        this.json = json;
    }
    toJSON() {
        const fields = TYPE_FIELDS[this.itemType] ?? [];
        const out: Record<string, any> = { itemType: this.itemType, key: 'ABCD1234', version: 0, dateAdded: '2020', tags: this.json.tags ?? [] };
        const extra: string[] = [];
        for (const [name, value] of Object.entries(this.json)) {
            if (['itemType', 'tags', 'creators'].includes(name)) continue;
            if (fields.includes(name)) out[name] = value;
            else extra.push(`${name}: ${value}`);
        }
        if (extra.length) out.extra = extra.join('\n');
        out.creators = (this.json.creators ?? []).map((creator: any) => ({
            ...creator,
            creatorType: (TYPE_ROLES[this.itemType] ?? []).includes(creator.creatorType) ? creator.creatorType : 'author',
        }));
        return out;
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    lastFromJSON = null;
    throwOnFromJSON = null;
    (Zotero as any).Item = FakeItem;
    (Zotero as any).Libraries.userLibraryID = 1;
});

describe('normalizeItemJson item type validation', () => {
    it.each([
        [{}, /itemType is required/],
        [{ itemType: '   ' }, /itemType is required/],
        [{ itemType: 'spaceship' }, /Unknown or unsupported itemType 'spaceship'/],
        [{ itemType: 'note' }, /Unknown or unsupported itemType 'note'/],
        [{ itemType: 'attachment' }, /Unknown or unsupported itemType 'attachment'/],
        [{ itemType: 'annotation' }, /Unknown or unsupported itemType 'annotation'/],
    ])('rejects %j as invalid_metadata', (input, message) => {
        const result = normalizeItemJson(input as any, 1);
        expect(result).toMatchObject({ ok: false, code: 'invalid_metadata' });
        expect((result as any).message).toMatch(message);
        expect((result as any).message).toContain('journalArticle');
    });

    it('reports Zotero rejecting the metadata as invalid_metadata', () => {
        throwOnFromJSON = new Error('bad field');
        const result = normalizeItemJson({ itemType: 'book', title: 'T' }, 1);
        expect(result).toMatchObject({ ok: false, code: 'invalid_metadata' });
        expect((result as any).message).toContain('bad field');
    });
});

describe('normalizeItemJson normalization', () => {
    it('strips transport keys from input and output', () => {
        const result = normalizeItemJson({
            itemType: 'journalArticle',
            title: 'T',
            attachments: [{ url: 'https://x/y.pdf' }],
            seeAlso: ['a'],
            accessDate: '2020-01-01',
            dateAdded: '2019',
            key: 'ZZZZ9999',
            version: 3,
            collections: ['C'],
            relations: {},
        }, 1);
        expect(result.ok).toBe(true);
        const sent = lastFromJSON!;
        for (const key of ['attachments', 'seeAlso', 'accessDate', 'dateAdded', 'key', 'version', 'collections', 'relations']) {
            expect(sent).not.toHaveProperty(key);
        }
        const item = (result as any).item;
        for (const key of ['key', 'version', 'dateAdded']) expect(item).not.toHaveProperty(key);
        expect(item).toMatchObject({ itemType: 'journalArticle', title: 'T' });
    });

    it('normalizes tags to manual-added objects and drops blanks and duplicates', () => {
        const result = normalizeItemJson({
            itemType: 'book',
            title: 'T',
            tags: ['ml', { tag: 'nlp', type: 0 }, '  ', 'ml', { nothing: true }, 5],
        }, 1) as any;
        expect(result.item.tags).toEqual([{ tag: 'ml', type: 1 }, { tag: 'nlp', type: 1 }]);
    });

    it('keeps notes as child notes, removing them from the Zotero round trip', () => {
        const result = normalizeItemJson({
            itemType: 'book',
            title: 'T',
            notes: [{ note: '<p>one</p>' }, '<p>two</p>', { note: '  ' }, 7],
        }, 1) as any;
        expect(lastFromJSON).not.toHaveProperty('notes');
        expect(result.item.notes).toEqual([{ note: '<p>one</p>' }, { note: '<p>two</p>' }]);
    });

    it('omits notes entirely when there are none', () => {
        const result = normalizeItemJson({ itemType: 'book', title: 'T' }, 1) as any;
        expect(result.item).not.toHaveProperty('notes');
    });

    it('defaults creators without a role to author and warns once', () => {
        const result = normalizeItemJson({
            itemType: 'book',
            title: 'T',
            creators: [{ firstName: 'Ada', lastName: 'Lovelace' }, { name: 'Org' }],
        }, 1) as any;
        expect(result.item.creators).toEqual([
            { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
            { creatorType: 'author', name: 'Org' },
        ]);
        expect(result.warnings.filter((w: string) => /without a role/.test(w))).toHaveLength(1);
    });

    it('stores a lone first name as a single-field creator and skips empty creators', () => {
        const result = normalizeItemJson({
            itemType: 'book',
            title: 'T',
            creators: [{ creatorType: 'author', firstName: 'Plato' }, { creatorType: 'author' }, null, 'str'],
        }, 1) as any;
        expect(result.item.creators).toEqual([{ creatorType: 'author', name: 'Plato' }]);
    });

    it('warns when a creator role is not valid for the item type', () => {
        const result = normalizeItemJson({
            itemType: 'book',
            title: 'T',
            creators: [{ creatorType: 'cartographer', lastName: 'Mercator' }],
        }, 1) as any;
        expect(result.item.creators[0].creatorType).toBe('author');
        expect(result.warnings).toContain('creator roles not valid for book were changed to author');
    });

    it('converts numeric values to strings and drops empty fields', () => {
        const result = normalizeItemJson({
            itemType: 'book',
            title: 'T',
            date: 2020,
            publisher: '   ',
            abstractNote: null,
        }, 1) as any;
        expect(lastFromJSON).toMatchObject({ date: '2020' });
        expect(lastFromJSON).not.toHaveProperty('publisher');
        expect(result.item.date).toBe('2020');
        expect(result.item).not.toHaveProperty('publisher');
        expect(result.item).not.toHaveProperty('abstractNote');
    });

    it('warns about fields Zotero moved to Extra', () => {
        const result = normalizeItemJson({
            itemType: 'journalArticle',
            title: 'T',
            publisher: 'Elsevier',
            ISBN: '9780262035613',
        }, 1) as any;
        expect(result.item.extra).toContain('publisher: Elsevier');
        expect(result.warnings).toContain('moved to Extra (not a journalArticle field): publisher, ISBN');
    });

    it('does not warn when Extra only holds lines the input already had', () => {
        const result = normalizeItemJson({ itemType: 'journalArticle', title: 'T', extra: 'PMID: 123' }, 1) as any;
        expect(result.ok).toBe(true);
        expect(result.item.extra).toContain('PMID: 123');
        expect(result.warnings.some((w: string) => /moved to Extra/.test(w))).toBe(false);
    });

    it('does not warn when Zotero keeps a base field under its type-specific name', () => {
        const original = FakeItem.prototype.toJSON;
        FakeItem.prototype.toJSON = function (this: any) {
            const out = original.call(this);
            delete out.extra;
            out.distributor = 'Studio';
            return out;
        };
        try {
            const result = normalizeItemJson({ itemType: 'film', title: 'T', publisher: 'Studio' }, 1) as any;
            expect(result.ok).toBe(true);
            expect(result.warnings.some((w: string) => /moved to Extra/.test(w))).toBe(false);
        } finally {
            FakeItem.prototype.toJSON = original;
        }
    });

    it('creates the item in the requested library', () => {
        const construct = vi.fn();
        (Zotero as any).Item = class extends FakeItem {
            constructor(type: string) {
                super(type);
                construct(type);
            }
            set libraryID(value: number) { construct(`library:${value}`); }
            get libraryID() { return 0; }
        };
        normalizeItemJson({ itemType: 'book', title: 'T' }, 7);
        expect(construct).toHaveBeenCalledWith('book');
        expect(construct).toHaveBeenCalledWith('library:7');
    });

    it('falls back to the user library when none is given', () => {
        const libs: number[] = [];
        (Zotero as any).Item = class extends FakeItem {
            set libraryID(value: number) { libs.push(value); }
            get libraryID() { return 0; }
        };
        normalizeItemJson({ itemType: 'book', title: 'T' });
        expect(libs.at(-1)).toBe(1);
    });

    it('does not mutate the caller input', () => {
        const input = { itemType: 'book', title: 'T', tags: ['x'], attachments: [{ url: 'u' }], date: 2020 };
        const snapshot = JSON.parse(JSON.stringify(input));
        normalizeItemJson(input, 1);
        expect(input).toEqual(snapshot);
    });
});

describe('normalizeTags', () => {
    it('returns an empty list for non-arrays', () => {
        expect(normalizeTags(undefined)).toEqual([]);
        expect(normalizeTags('tag')).toEqual([]);
    });

    it('trims names, dedupes and honors the requested type', () => {
        expect(normalizeTags([' a ', 'a', { tag: 'b' }], 0)).toEqual([{ tag: 'a', type: 0 }, { tag: 'b', type: 0 }]);
    });
});

describe('normalizeItemJson base-field remapping', () => {
    it('stores a field of another item type under this type\'s variant of the same base field', () => {
        const ids: Record<string, number> = { publisher: 100, institution: 101, university: 102, title: 110 };
        const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
        const fields = Zotero.ItemFields as any;
        const saved = { ...fields };
        Object.assign(fields, {
            getID: (name: string) => ids[name] ?? 0,
            getName: (id: number) => names[id],
            // This type holds the publisher base field as `institution`.
            isValidForType: (id: number) => id === ids.institution || id === ids.title,
            getFieldIDFromTypeAndBase: (_type: number, base: number) => (base === ids.publisher ? ids.institution : false),
            getTypeFieldsFromBase: (base: number) => (base === ids.publisher ? ['institution', 'university'] : []),
        });
        try {
            const result = normalizeItemJson({ itemType: 'book', title: 'R', university: 'MIT' } as any, 1);
            expect(result.ok).toBe(true);
            expect(lastFromJSON).toMatchObject({ institution: 'MIT' });
            expect(lastFromJSON).not.toHaveProperty('university');
            expect(((result as any).warnings ?? []).join(' ')).not.toMatch(/university/);
        } finally {
            Object.assign(fields, saved);
        }
    });
});

describe('normalizeItemJson general field names', () => {
    it('maps the general volume field to the type\'s own variant', () => {
        const ids: Record<string, number> = { volume: 200, codeVolume: 201, title: 110 };
        const names = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
        const fields = Zotero.ItemFields as any;
        const saved = { ...fields };
        Object.assign(fields, {
            getID: (name: string) => ids[name] ?? 0,
            getName: (id: number) => names[id],
            // This type holds the volume base field as `codeVolume`, as a statute does.
            isValidForType: (id: number) => id === ids.codeVolume || id === ids.title,
            getFieldIDFromTypeAndBase: (_type: number, base: number) => (base === ids.volume ? ids.codeVolume : false),
            getTypeFieldsFromBase: (base: number) => (base === ids.volume ? ['codeVolume', 'reporterVolume'] : []),
        });
        try {
            const result = normalizeItemJson({ itemType: 'book', title: 'Act', volume: '45' } as any, 1);
            expect(result.ok).toBe(true);
            expect(lastFromJSON).toMatchObject({ codeVolume: '45' });
            expect(lastFromJSON).not.toHaveProperty('volume');
        } finally {
            Object.assign(fields, saved);
        }
    });
});

describe('normalizeItemJson translator creators', () => {
    it('keeps a single-field (fieldMode 1) creator as one name', () => {
        const result = normalizeItemJson({
            itemType: 'book',
            title: 'T',
            creators: [{ creatorType: 'author', lastName: 'World Health Organization', fieldMode: 1 } as any],
        }, 1);
        expect(result.ok).toBe(true);
        expect(lastFromJSON?.creators).toEqual([{ creatorType: 'author', name: 'World Health Organization' }]);
    });
});
