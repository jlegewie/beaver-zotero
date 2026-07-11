import type { DocumentExtractResult } from './shared/documentExtractResult';
import type { ExtractContentKind } from './shared/contentKinds';

type IndexableContentKind = Extract<ExtractContentKind, 'pdf' | 'epub' | 'snapshot'>;

const OMIT_KEYS = new Set(['createdAt', 'debug']);
const OMIT_DIAGNOSTIC_KEYS = new Set(['timings', 'settings']);
const GEOMETRY_KEYS = new Set(['bbox', 'bboxes', 'viewBox', 'width', 'height']);

function normalizeNumber(value: number, precision: number | null): number | string {
    if (!Number.isFinite(value)) {
        throw new TypeError('Structured documents cannot contain non-finite numbers');
    }
    if (Object.is(value, -0)) value = 0;
    if (precision == null || Number.isInteger(value)) return value;
    // Geometry is emitted as a fixed decimal string in the hash projection so
    // equivalent values never depend on engine-specific float formatting.
    return value.toFixed(precision);
}

function canonicalize(
    value: unknown,
    options: {
        geometryPrecision: number;
        geometryContext?: boolean;
        inDiagnostics?: boolean;
    },
): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return normalizeNumber(
            value,
            options.geometryContext ? options.geometryPrecision : null,
        );
    }
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalize(entry, options));
    }
    if (typeof value !== 'object') {
        throw new TypeError(`Unsupported structured-document value: ${typeof value}`);
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
        if (OMIT_KEYS.has(key)) continue;
        if (options.inDiagnostics && OMIT_DIAGNOSTIC_KEYS.has(key)) continue;
        const entry = source[key];
        if (entry === undefined) continue;
        result[key] = canonicalize(entry, {
            geometryPrecision: options.geometryPrecision,
            geometryContext: options.geometryContext || GEOMETRY_KEYS.has(key),
            inDiagnostics: key === 'diagnostics',
        });
    }
    return result;
}

/**
 * Stable, content-only serialization used exclusively for index identity.
 * It is intentionally separate from the cache/wire serializer.
 */
export function canonicalSerializeStructuredDocument(
    contentKind: IndexableContentKind,
    document: DocumentExtractResult,
): string {
    const pdfPrecision = contentKind === 'pdf'
        ? Number((document as any)?.document?.bboxPrecision ?? 1)
        : 3;
    const geometryPrecision = Number.isInteger(pdfPrecision) && pdfPrecision >= 0
        ? pdfPrecision
        : 1;
    return JSON.stringify(canonicalize(
        { content_kind: contentKind, payload: document },
        { geometryPrecision },
    ));
}

export async function computeStructuredDocumentHash(
    contentKind: IndexableContentKind,
    document: DocumentExtractResult,
): Promise<string> {
    const bytes = new TextEncoder().encode(
        canonicalSerializeStructuredDocument(contentKind, document),
    );
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        bytes as Uint8Array<ArrayBuffer>,
    );
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')).join('');
}

