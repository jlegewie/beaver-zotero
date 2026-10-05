import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/export/exportRuntime', () => ({ loadExportRuntime: vi.fn() }));
vi.mock('../../../src/services/export/exportCitations', () => ({ formatExportCitations: vi.fn() }));

import { exportFileName } from '../../../src/services/export/instanceExport';

describe('exportFileName', () => {
    it('replaces reserved characters and bounds the length', () => {
        expect(exportFileName('A/B: "c"?\n', 'docx')).toBe('A B c.docx');
        expect(exportFileName('x'.repeat(200), 'docx')).toBe(`${'x'.repeat(80)}.docx`);
        expect(exportFileName('  ', 'docx')).toBe('Beaver export.docx');
    });
});
