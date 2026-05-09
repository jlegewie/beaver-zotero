/**
 * Shared smoke-test fixture path. Centralized so a future fixture change
 * touches one constant rather than every smoke file.
 *
 * The repo only ships SHA-named PDFs under
 * `tests/fixtures/pdfs/sentences/_shared/`; we pick the first one
 * alphabetically.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const SMOKE_PDF: string = join(
    repoRoot,
    'tests/fixtures/pdfs/sentences/_shared/0a3a5c40534376346b36c03c4469694674fd85ea1493c493be7c777df1ea4561.pdf',
);

export function smokePdfExists(): boolean {
    return existsSync(SMOKE_PDF);
}
