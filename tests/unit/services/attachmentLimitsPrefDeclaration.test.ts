/**
 * Lock the file-size ceiling to its preference declaration.
 *
 * `attachmentLimits` reads `maxAttachmentFileSizeMB` through the runtime
 * adapter, which takes an untyped key string. Renaming, dropping, or commenting
 * out the `pref(...)` line in `addon/prefs.js` therefore type-checks and lints
 * cleanly: the read just returns `undefined` and every ceiling silently reverts
 * to the built-in default, so the user's setting stops working with no signal.
 * The same goes for the declared default drifting away from the built-in one,
 * which would make the value shown in `about:config` not the value in force.
 *
 * Asserting against the source is the only option here — `prefs.js` is loaded
 * by Zotero, not importable.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_FILE_SIZE_MB } from '@beaver/agent-core/transport/attachmentLimits';

const prefsSource = readFileSync(
    fileURLToPath(new URL('../../../addon/prefs.js', import.meta.url)),
    'utf8',
);

/**
 * Declarations of one key, ignoring commented-out ones. Block comments are
 * stripped (a `pref(...)` inside one can start its own line); line comments
 * need no stripping, because the match is anchored to the start of a line and
 * only tolerates indentation before `pref`.
 */
function declarationsOf(key: string): string[] {
    const live = prefsSource.replace(/\/\*[\s\S]*?\*\//g, '');
    const pattern = new RegExp(String.raw`^[ \t]*pref\("${key}",\s*([^)]+)\)`, 'gm');
    return [...live.matchAll(pattern)].map((match) => match[1].trim());
}

describe('the attachment file-size preference declaration', () => {
    it('declares the key attachmentLimits reads, with the same default', () => {
        const declarations = declarationsOf('maxAttachmentFileSizeMB');

        // Exactly one: a duplicate line would make the last call win, so the
        // default asserted below would not be the one in force.
        expect(
            declarations,
            'addon/prefs.js must declare maxAttachmentFileSizeMB exactly once',
        ).toHaveLength(1);
        expect(
            Number(declarations[0]),
            'the default declared in addon/prefs.js must equal DEFAULT_MAX_FILE_SIZE_MB',
        ).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    });
});
