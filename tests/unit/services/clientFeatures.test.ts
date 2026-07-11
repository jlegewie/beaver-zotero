import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    CLIENT_FEATURES,
    ZOTERO_PLUGIN_CLIENT_TYPE,
    ZOTERO_PLUGIN_FEATURES,
} from '../../../src/services/agentProtocol';

// Guards the client-feature handshake (Lane C).
type Op = 'gt' | 'gte';

const VERSION_GATES: { feature: string; minVersion: string; op: Op }[] = [
    { feature: 'library_management', minVersion: '0.10.999', op: 'gt' },
    { feature: 'manage_library_structure', minVersion: '0.17.999', op: 'gt' },
    { feature: 'note_support', minVersion: '0.17.0', op: 'gte' },
    { feature: 'note_append', minVersion: '0.19.4', op: 'gte' },
    { feature: 'annotation_support', minVersion: '0.19.999', op: 'gte' },
    { feature: 'find_annotations', minVersion: '0.20.0b4', op: 'gte' },
    { feature: 'extract', minVersion: '0.17.0', op: 'gt' },
    { feature: 'beaver_extract', minVersion: '0.19.999', op: 'gte' },
    { feature: 'image_extraction', minVersion: '0.17.999', op: 'gt' },
    { feature: 'view_page_images', minVersion: '0.17.999', op: 'gt' },
    { feature: 'read_tool', minVersion: '0.20.999', op: 'gte' },
    { feature: 'view_tool', minVersion: '0.20.999', op: 'gte' },
    { feature: 'find_in_attachments', minVersion: '0.20.999', op: 'gt' },
    { feature: 'document_payload_budget', minVersion: '0.20.999', op: 'gte' },
    { feature: 'filter_only_search', minVersion: '0.15.999', op: 'gt' },
    { feature: 'sentence_level_citation', minVersion: '0.19.999', op: 'gte' },
    { feature: 'unified_citation_format', minVersion: '0.19.999', op: 'gte' },
    { feature: 'citation_v2', minVersion: '0.20.999', op: 'gte' },
    { feature: 'tool_result_view', minVersion: '0.20.999', op: 'gte' },
    { feature: 'external_search_surcharge', minVersion: '0.12.3', op: 'gte' },
    { feature: 'edit_metadata_creators', minVersion: '0.11.2', op: 'gte' },
];

// Features the backend never derives from version. ask_user_question is
// declaration-only because client-feature declaration predates it — every
// client that ships the question card also declares features explicitly.
// portable_ids is declaration-only because it gates emission of the
// device-portable model-facing id format, which every declaring client both
// emits and resolves — there is no version threshold to derive it from.
const DECLARATION_ONLY_FEATURES = ['external_files', 'ask_user_question', 'portable_ids'];

// The full backend feature vocabulary (ALL_FEATURES in version_gates.py): every
// version-gated feature plus the declaration-only ones.
const ALL_BACKEND_FEATURES = [
    ...VERSION_GATES.map((g) => g.feature),
    ...DECLARATION_ONLY_FEATURES,
].sort();

// =============================================================================
// PEP 440 version comparison (subset) — reproduces packaging.version.Version
// ordering for the release + pre-release forms used by the thresholds above
// (e.g. "0.20.0b4" is a beta that sorts below the "0.20.0" final) as well as
// the npm/semver-style pre-release suffix the package.json version uses (e.g.
// "0.22.0-beta.1"). `packaging.version.Version` normalizes both spellings to
// the same pre-release representation, so this mirrors that normalization.
// =============================================================================
const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };
const PRE_ALIASES: Record<string, keyof typeof PRE_ORDER> = {
    a: 'a', alpha: 'a',
    b: 'b', beta: 'b',
    c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc',
};

function parseVersion(v: string): { release: number[]; pre: { stage: number; num: number } | null } {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d+))?$/i.exec(v);
    if (!m) throw new Error(`Unparseable version: ${v}`);
    const preLabel = m[4] ? PRE_ALIASES[m[4].toLowerCase()] : undefined;
    return {
        release: [Number(m[1]), Number(m[2]), Number(m[3])],
        pre: preLabel ? { stage: PRE_ORDER[preLabel], num: Number(m[5]) } : null,
    };
}

function compareVersions(a: string, b: string): number {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    for (let i = 0; i < 3; i++) {
        if (pa.release[i] !== pb.release[i]) return pa.release[i] < pb.release[i] ? -1 : 1;
    }
    // A final release outranks any pre-release of the same release tuple.
    if (!pa.pre && !pb.pre) return 0;
    if (!pa.pre) return 1;
    if (!pb.pre) return -1;
    if (pa.pre.stage !== pb.pre.stage) return pa.pre.stage < pb.pre.stage ? -1 : 1;
    if (pa.pre.num !== pb.pre.num) return pa.pre.num < pb.pre.num ? -1 : 1;
    return 0;
}

function featuresFromVersion(version: string): string[] {
    return VERSION_GATES.filter(({ minVersion, op }) => {
        const cmp = compareVersions(version, minVersion);
        return op === 'gt' ? cmp > 0 : cmp >= 0;
    }).map(({ feature }) => feature);
}

// The plugin version drives the derivation, so the contract is checked against
// whatever this build actually is.
const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
) as { version: string };
const CURRENT_VERSION = pkg.version;

// Expected declared set for the current build: everything the backend grants a
// client of this version, plus the declaration-only features.
const EXPECTED_DECLARED_FEATURES = [
    ...featuresFromVersion(CURRENT_VERSION),
    ...DECLARATION_ONLY_FEATURES,
].sort();

describe('client feature declaration (Lane C)', () => {
    it('declares the Zotero plugin client type', () => {
        expect(ZOTERO_PLUGIN_CLIENT_TYPE).toBe('zotero-plugin');
    });

    it('feature vocabulary matches the backend FEAT_* string values exactly', () => {
        expect(Object.values(CLIENT_FEATURES).slice().sort()).toEqual(ALL_BACKEND_FEATURES);
    });

    it('declares no duplicate features', () => {
        expect(new Set(ZOTERO_PLUGIN_FEATURES).size).toBe(ZOTERO_PLUGIN_FEATURES.length);
    });

    it('declares exactly the features the backend grants this plugin version', () => {
        // Derived from the version-gate table — not a frozen mirror — so a new
        // backend gate that this version crosses forces a CLIENT_FEATURES update.
        expect(ZOTERO_PLUGIN_FEATURES.slice().sort()).toEqual(EXPECTED_DECLARED_FEATURES);
    });

    it('declares citation_v2 so streaming run_complete events serialize as v2', () => {
        // Regression guard: without this flag the backend downgrades streamed
        // citations to the legacy shape (no display_name), while DB-loaded
        // threads — gated on the version header — still get v2 and render fine.
        expect(featuresFromVersion(CURRENT_VERSION)).toContain('citation_v2');
        expect(ZOTERO_PLUGIN_FEATURES).toContain('citation_v2');
    });
});

describe('version-gate mirror integrity', () => {
    it('the gate table plus declaration-only features cover the whole vocabulary', () => {
        const tableFeatures = [
            ...VERSION_GATES.map((g) => g.feature),
            ...DECLARATION_ONLY_FEATURES,
        ];
        // No duplicate rows, and the table is the same vocabulary asserted above.
        expect(new Set(tableFeatures).size).toBe(tableFeatures.length);
        expect(tableFeatures.slice().sort()).toEqual(ALL_BACKEND_FEATURES);
    });

    it('version comparison reproduces PEP 440 ordering at the boundaries', () => {
        // Self-check the comparator so a derivation built on it can be trusted.
        expect(compareVersions('0.21.1', '0.20.999')).toBe(1);
        expect(compareVersions('0.20.999', '0.21.0')).toBe(-1);
        expect(compareVersions('0.20.0b4', '0.20.0')).toBe(-1); // beta sorts below final
        expect(compareVersions('0.20.0b4', '0.20.0b5')).toBe(-1);
        expect(compareVersions('0.19.4', '0.19.4')).toBe(0);
        // The `>` gates exclude an exact-threshold match; `>=` gates include it.
        expect(compareVersions('0.20.999', '0.20.999')).toBe(0);
    });

    it('normalizes the npm/semver pre-release spelling used by package.json', () => {
        // "0.22.0-beta.1" (package.json) and "0.22.0b1" (PEP 440 compact form used
        // in the gate table) must compare equal, matching packaging.version.Version.
        expect(compareVersions('0.22.0-beta.1', '0.22.0b1')).toBe(0);
        expect(compareVersions('0.22.0-beta.1', '0.22.0')).toBe(-1);
        expect(compareVersions('0.22.0-beta.2', '0.22.0-beta.1')).toBe(1);
    });
});
