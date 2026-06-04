import type { BeaverExtractResult } from '../../../beaver-extract/schema/schema';
import type { ExtractContentKind } from './contentKinds';

export type PdfDocumentExtractResult = BeaverExtractResult & {
    content_kind: Extract<ExtractContentKind, 'pdf'>;
};

export interface TextDocumentLine {
    id: string;
    line: number;
    text: string;
}

export interface TextDocumentExtractResult {
    content_kind: Extract<ExtractContentKind, 'text'>;
    schemaVersion: string;
    createdAt?: string;
    mode: 'text';
    document: {
        lineCount: number;
        sourceContentType?: string;
        lines: TextDocumentLine[];
    };
}

export type DocumentExtractResult =
    | PdfDocumentExtractResult
    | TextDocumentExtractResult;
