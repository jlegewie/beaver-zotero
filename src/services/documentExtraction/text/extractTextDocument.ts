import type { TextDocumentExtractResult } from '../shared/documentExtractResult';

export const TEXT_SCHEMA_VERSION = '1';

function normalizeText(data: Uint8Array): string {
    const decoded = new TextDecoder('utf-8').decode(data);
    return decoded
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

/** Decode UTF-8 attachment bytes into Beaver's line-addressable text schema. */
export function extractTextDocument(args: {
    data: Uint8Array;
    contentType: string;
}): TextDocumentExtractResult {
    const text = normalizeText(args.data);
    const rawLines = text === '' ? [] : text.split('\n');
    const lines = rawLines.map((lineText, index) => ({
        id: `l${index + 1}`,
        line: index + 1,
        text: lineText,
    }));

    return {
        content_kind: 'text',
        schemaVersion: TEXT_SCHEMA_VERSION,
        mode: 'text',
        document: {
            lineCount: lines.length,
            sourceContentType: args.contentType,
            lines,
        },
    };
}

