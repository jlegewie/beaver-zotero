/**
 * Shared smoke-test fixture path. Centralized so a future fixture change
 * touches one constant rather than every smoke file.
 *
 * Points at a SHA-named PDF under `tests/fixtures/pdfs/extract-public/_shared/`,
 * which is the committed, redistributable corpus that every machine and CI
 * is guaranteed to have.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const SMOKE_PDF: string = join(
    repoRoot,
    'tests/fixtures/pdfs/extract-public/_shared/d86a26bf17a0e19194abe41f10b32b4cf86e8caddf3c854773802e5a76b607cf.pdf',
);

export function smokePdfExists(): boolean {
    return existsSync(SMOKE_PDF);
}
