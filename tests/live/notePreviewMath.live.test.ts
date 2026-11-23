import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { closeNoteEditor, createNote, deleteNote, openNoteEditor } from './helpers/noteTestClient';

/**
 * The note-editor diff preview for math edits.
 *
 * `read_note` keeps `<span class="math">` / `<pre class="math">` wrappers, but
 * models routinely send the dollar-only anchor (`$E = mc^2$`) they learned from
 * older reads. The preview must resolve those the same way the matcher does —
 * whole element, not a slice of its LaTeX — otherwise the approval card shows a
 * KaTeX error or a formula that exists in neither version.
 *
 * Only reproducible against a live editor: these assertions read the rendered
 * ProseMirror DOM, where KaTeX has already run.
 */

const libraryID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);
const NOTE_HTML = '<p>Energy <span class="math">$E = mc^2$</span> and a $5 fee.</p>'
    + '<pre class="math">$$a + b$$</pre>';

const notes: string[] = [];
let available = false;

/** LaTeX of every formula the preview rendered, in document order. */
function renderedFormulas(html: string): string[] {
    return [...html.matchAll(/annotation encoding="application\/x-tex">([^<]*)</g)]
        .map(match => match[1]);
}

async function previewHtml(noteKey: string, edit: Record<string, unknown>): Promise<string> {
    const preview = await post<any>('/beaver/test/note-preview', {
        library_id: libraryID, zotero_key: noteKey, edits: [edit],
    });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.html, 'preview returned no editor HTML').toBeTruthy();
    // A split math element renders as a KaTeX parse error in the note.
    expect(preview.html).not.toContain('katex-error');
    return preview.html as string;
}

async function seedNote(): Promise<string> {
    const note = await createNote({ library_id: libraryID, html: NOTE_HTML, title: 'Math preview' });
    notes.push(note.zotero_key);
    const opened = await openNoteEditor(libraryID, note.zotero_key);
    expect(opened.ok && opened.in_editor, JSON.stringify(opened)).toBe(true);
    return note.zotero_key;
}

beforeAll(async () => { available = await isZoteroAvailable(); });
afterEach(async () => {
    if (!available) return;
    await post('/beaver/test/note-preview', { dismiss: true });
    for (const noteKey of notes.splice(0)) {
        await closeNoteEditor(libraryID, noteKey);
        await deleteNote(libraryID, noteKey);
    }
});

describe('note editor diff preview — math anchors (live)', () => {
    beforeEach(ctx => skipIfNoZotero(ctx, available));

    it('renders a legacy dollar anchor as a whole-element replacement', async () => {
        const noteKey = await seedNote();
        const html = await previewHtml(noteKey, {
            operation: 'str_replace', oldString: '$E = mc^2$', newString: '$E = mc^{2}$',
        });
        // Old and new are separate math nodes. A boundary inside the element
        // would merge them into one node holding `E = mc^2{2}`.
        expect(renderedFormulas(html)).toEqual(['E = mc^2', 'E = mc^{2}', 'a + b']);
    });

    it('drops the whole element when a formula becomes prose', async () => {
        const noteKey = await seedNote();
        const html = await previewHtml(noteKey, {
            operation: 'str_replace', oldString: '$E = mc^2$', newString: 'mass-energy equivalence',
        });
        expect(html).toContain('mass-energy equivalence');
        expect(renderedFormulas(html)).toEqual(['E = mc^2', 'a + b']);
    });

    it('renders a display-math anchor', async () => {
        const noteKey = await seedNote();
        const html = await previewHtml(noteKey, {
            operation: 'str_replace', oldString: '$$a + b$$', newString: 'the sum',
        });
        expect(html).toContain('the sum');
        expect(renderedFormulas(html)).toEqual(['E = mc^2', 'a + b']);
    });

    it('renders a paragraph anchor that embeds inline math', async () => {
        const noteKey = await seedNote();
        const html = await previewHtml(noteKey, {
            operation: 'str_replace',
            oldString: '<p>Energy $E = mc^2$ and a $5 fee.</p>',
            newString: '<p>Replaced paragraph.</p>',
        });
        expect(html).toContain('Replaced paragraph');
        expect(renderedFormulas(html)).toEqual(['E = mc^2', 'a + b']);
    });

    it('renders a wrapper anchor copied verbatim from read_note', async () => {
        const noteKey = await seedNote();
        const html = await previewHtml(noteKey, {
            operation: 'str_replace',
            oldString: '<span class="math">$E = mc^2$</span>',
            newString: '<span class="math">$E = mc^{2}$</span>',
        });
        expect(renderedFormulas(html)).toEqual(['E = mc^2', 'E = mc^{2}', 'a + b']);
    });

    it('shows only the injection for insert_after on a math anchor', async () => {
        const noteKey = await seedNote();
        const html = await previewHtml(noteKey, {
            operation: 'insert_after', oldString: '$E = mc^2$', newString: '$E = mc^2$ (Einstein)',
        });
        expect(html).toContain('(Einstein)');
        expect(renderedFormulas(html)).toEqual(['E = mc^2', 'a + b']);
    });

    it('leaves prose dollars literal', async () => {
        const noteKey = await seedNote();
        const html = await previewHtml(noteKey, {
            operation: 'str_replace', oldString: 'a $5 fee', newString: 'a $6 fee',
        });
        expect(html).toContain('6');
        expect(renderedFormulas(html)).toEqual(['E = mc^2', 'a + b']);
    });
});
