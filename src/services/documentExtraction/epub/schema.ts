import type { DomDocument } from "../dom/schema";
import type { ZoteroDocumentErrorCode } from "../../agentProtocol";

export const EPUB_CONTENT_KIND = "epub" as const;
export const EPUB_SCHEMA_VERSION = "1" as const;

export type EpubContentKind = typeof EPUB_CONTENT_KIND;

export interface EpubDocument extends DomDocument {
    content_kind: typeof EPUB_CONTENT_KIND;
    schemaVersion: typeof EPUB_SCHEMA_VERSION;
}

export type ExtractEpubResult =
    | { kind: "ok"; document: EpubDocument }
    | { kind: "response_error"; code: ZoteroDocumentErrorCode; message: string };
