import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/export/exportRuntime', () => ({
    loadExportRuntime: vi.fn(() => ({
        parseExportSource: vi.fn(() => ({ title: 'Doc', clusters: [] })),
        parseNoteDoc: vi.fn(() => ({ title: 'Doc', clusters: [], images: {} })),
    })),
}));
vi.mock('../../../src/services/export/exportCitations', () => ({
    formatExportCitations: vi.fn(async () => ({ citations: {}, warnings: [] })),
}));
vi.mock('../../../src/services/export/noteExportSource', () => ({
    readNoteForExport: vi.fn(() => ({ doc: { type: 'doc' }, citationItems: [] })),
}));
vi.mock('../../../src/services/export/noteImages', () => ({
    loadNoteImages: vi.fn(async () => ({ images: {}, missing: 0, remote: 0 })),
}));
vi.mock('../../../src/services/export/exportTelemetry', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/services/export/exportTelemetry')>()),
    reportExport: vi.fn(),
}));

import { InstanceExport, type ExportResult } from '../../../src/services/export/instanceExport';
import {
    exportErrorCode,
    exportWarningCodes,
    noteOriginFromHtml,
    reportExport,
} from '../../../src/services/export/exportTelemetry';
import { getBeaverNoteFooterHTML } from '../../../src/utils/noteProvenance';
import { buildEditFooterHtml } from '../../../src/utils/noteEditFooter';
import type { ExportSource } from '@beaver/agent-export/types';

const wrap = (body: string) => `<div data-schema-version="9"><h1>Review</h1><p>Text.</p>${body}</div>`;

describe('noteOriginFromHtml', () => {
    it('tells a note Beaver created from one it only edited and one the user wrote', () => {
        expect(noteOriginFromHtml(wrap(getBeaverNoteFooterHTML('thread-1', 'run-1')))).toBe('created');
        expect(noteOriginFromHtml(wrap(buildEditFooterHtml(['thread-1'])))).toBe('edited');
        expect(noteOriginFromHtml(wrap(''))).toBe('user');
    });

    it('counts a note Beaver created and later edited as created', () => {
        const html = wrap(getBeaverNoteFooterHTML('thread-1') + buildEditFooterHtml(['thread-2']));
        expect(noteOriginFromHtml(html)).toBe('created');
    });

    it('does not mistake the words in user text for a footer', () => {
        expect(noteOriginFromHtml(wrap('<p>Edited by Beaver</p><p>Created by Beaver, mostly</p>'))).toBe('user');
    });
});

describe('telemetry labels', () => {
    it('sends each warning code once, and only codes the backend accepts', () => {
        expect(exportWarningCodes([
            { code: 'unresolved_citations', message: 'a' },
            { code: 'unresolved_citations', message: 'b' },
            { code: 'Not A Code' as any, message: 'c' },
            { code: 'images_missing', message: 'd' },
        ])).toEqual(['unresolved_citations', 'images_missing']);
    });

    it('sends an error code only when the error carries a well-formed one', () => {
        expect(exportErrorCode(Object.assign(new Error('x'), { code: 'note_not_found' }))).toBe('note_not_found');
        expect(exportErrorCode(new Error('disk full'))).toBeUndefined();
        expect(exportErrorCode(Object.assign(new Error('x'), { code: 'NS_ERROR_FAILURE' }))).toBeUndefined();
    });
});

// Sending usage reports is disabled in `InstanceExport` for now.
describe.skip('InstanceExport usage reports', () => {
    const saved: ExportResult = {
        status: 'saved',
        path: '/out/Doc.docx',
        files: ['/out/Doc.docx'],
        warnings: [{ code: 'math_as_text', message: 'm' }],
        stats: { clusters: 3, bibliographyEntries: 2 } as any,
    };
    const source = (kind: ExportSource['kind']): ExportSource => ({
        kind,
        title: 'Doc',
        blocks: [],
        citations: { citationsByKey: {}, externalReferences: {}, externalItemMapping: {}, pageLabelsByAttachmentId: {} } as any,
        provenance: { runIds: [] },
    });
    let exporter: InstanceExport;

    beforeEach(() => {
        vi.clearAllMocks();
        exporter = new InstanceExport();
        vi.spyOn(exporter as any, 'outputPath').mockResolvedValue('/out/Doc.docx');
        vi.spyOn(exporter as any, 'writeResult').mockResolvedValue(saved);
        (globalThis as any).Zotero = { Beaver: { citationService: {} } };
    });

    it('reports a saved export with where it started and what it held', async () => {
        await exporter.run({ source: source('response'), format: 'docx' }, { surface: 'message_menu' });

        expect(reportExport).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'response',
            format: 'docx',
            outcome: 'saved',
            surface: 'message_menu',
            citation_count: 3,
            bibliography_entries: 2,
            warning_codes: ['math_as_text'],
        }));
    });

    it('reports a note source as the created note exported as Beaver wrote it', async () => {
        await exporter.run({ source: source('note'), format: 'pdf' }, { surface: 'run_artifacts' });

        expect(reportExport).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'note',
            note_origin: 'created',
            note_fallback: true,
        }));
    });

    it('does not report a canceled save dialog or an export to a given path', async () => {
        vi.spyOn(exporter as any, 'outputPath').mockResolvedValue(null);
        await exporter.run({ source: source('thread'), format: 'markdown' });
        vi.spyOn(exporter as any, 'outputPath').mockResolvedValue('/dev/out.md');
        await exporter.run({ source: source('thread'), format: 'markdown', path: '/dev/out.md' });

        expect(reportExport).not.toHaveBeenCalled();
    });

    it('reports a failed export with its error code and still throws', async () => {
        vi.spyOn(exporter as any, 'writeResult').mockRejectedValue(Object.assign(new Error('no window'), { code: 'window_unavailable' }));

        await expect(exporter.run({ source: source('thread'), format: 'latex' }, { surface: 'thread_menu' }))
            .rejects.toThrow('no window');
        expect(reportExport).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'thread',
            outcome: 'failed',
            error_code: 'window_unavailable',
            surface: 'thread_menu',
        }));
    });

    it('reports a note export with who wrote the note', async () => {
        const note = { isNote: () => true, loadAllData: vi.fn(), getNoteTitle: () => 'Review' };
        (globalThis as any).Zotero = {
            Beaver: { citationService: {} },
            Libraries: { userLibraryID: 1 },
            Items: { getByLibraryAndKeyAsync: vi.fn(async () => note) },
        };

        await exporter.exportNote(
            { note: { key: 'NOTE0001' }, html: wrap(buildEditFooterHtml(['thread-1'])), format: 'docx' },
            { surface: 'item_menu' },
        );

        expect(reportExport).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'note',
            outcome: 'saved',
            surface: 'item_menu',
            note_origin: 'edited',
        }));
    });

    it('reports a note that could not be found as a failed note export', async () => {
        (globalThis as any).Zotero = {
            Beaver: { citationService: {} },
            Libraries: { userLibraryID: 1 },
            Items: { getByLibraryAndKeyAsync: vi.fn(async () => null) },
        };

        await expect(exporter.exportNote({ note: { key: 'GONE0001' }, format: 'docx' }, { surface: 'run_artifacts' }))
            .rejects.toMatchObject({ code: 'note_not_found' });
        expect(reportExport).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'note',
            outcome: 'failed',
            error_code: 'note_not_found',
        }));
    });

    it('leaves a missing note unreported when the caller falls back to another version', async () => {
        (globalThis as any).Zotero = {
            Beaver: { citationService: {} },
            Libraries: { userLibraryID: 1 },
            Items: { getByLibraryAndKeyAsync: vi.fn(async () => null) },
        };

        await expect(exporter.exportNote(
            { note: { key: 'GONE0001' }, format: 'docx' },
            { surface: 'note_card', fallsBackWhenNoteMissing: true },
        )).rejects.toMatchObject({ code: 'note_not_found' });
        expect(reportExport).not.toHaveBeenCalled();
    });
});
