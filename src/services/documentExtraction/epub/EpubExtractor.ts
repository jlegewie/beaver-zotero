import {
    buildDomCitationIndex,
    createDomCounters,
    parseDomSection,
    type DomSection,
} from "../dom";
import {
    EPUB_CONTENT_KIND,
    EPUB_SCHEMA_VERSION,
    type EpubDocument,
    type ExtractEpubResult,
} from "./schema";
import { effectiveMaxFileSizeMB } from "../../attachmentLimits";
import { isRemoteAccessAvailable } from "../attachmentSource";

interface ZoteroEpubModule {
    EPUB: new (filePath: string) => {
        getSectionDocuments(): AsyncIterable<{ href: string; doc: XMLDocument | Document }>;
        close(): void;
    };
}

export interface ExtractEpubDocumentOptions {
    maxFileSizeMB?: number | null;
    onFileNotSyncedLocally?: () => void;
}

type EpubResponseError = Extract<ExtractEpubResult, { kind: "response_error" }>;

function responseError(
    code: EpubResponseError["code"],
    message: string,
): ExtractEpubResult {
    return { kind: "response_error", code, message };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function formatMB(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Extract a local Zotero EPUB attachment into Beaver's section-based schema. */
export async function extractEpubDocument(item: Zotero.Item): Promise<EpubDocument> {
    if (!isEpubAttachment(item)) {
        throw new Error("Item is not an EPUB attachment");
    }

    const filePath = await item.getFilePathAsync();
    if (!filePath) {
        throw new Error("EPUB attachment has no local file");
    }

    return extractEpubDocumentFromFile(filePath);
}

/**
 * Extract an EPUB into Beaver's section-based schema directly from a file path.
 *
 * Path-based core shared by the item-based extractor and dev tooling that runs
 * over corpus files that are not Zotero attachments. Throws raw errors; callers
 * that need request-safe error shapes use {@link extractEpubDocumentSafe}.
 */
export async function extractEpubDocumentFromFile(filePath: string): Promise<EpubDocument> {
    const { EPUB } = (globalThis as any).ChromeUtils.importESModule(
        "chrome://zotero/content/EPUB.mjs",
    ) as ZoteroEpubModule;
    const epub = new EPUB(filePath);
    const counters = createDomCounters();
    const sections: DomSection[] = [];

    try {
        let sectionIndex = 0;
        for await (const { href, doc } of epub.getSectionDocuments()) {
            sections.push(parseDomSection({
                doc,
                sectionIndex,
                rawHref: href,
                counters,
            }));
            sectionIndex += 1;
            await Zotero.Promise.delay(0);
        }
    } finally {
        epub.close();
    }

    return {
        content_kind: EPUB_CONTENT_KIND,
        schemaVersion: EPUB_SCHEMA_VERSION,
        sectionCount: sections.length,
        sections,
        citationIndex: buildDomCitationIndex(sections),
    };
}

/** Extract an EPUB attachment with request-safe preflight and error responses. */
export async function extractEpubDocumentSafe(
    item: Zotero.Item,
    options?: ExtractEpubDocumentOptions,
): Promise<ExtractEpubResult> {
    let isEpub = false;
    try {
        isEpub = isEpubAttachment(item);
    } catch (error) {
        return responseError(
            "unsupported_type",
            `Unable to determine whether the attachment is an EPUB: ${getErrorMessage(error)}`,
        );
    }

    if (!isEpub) {
        return responseError("unsupported_type", "Attachment is not an EPUB file.");
    }

    let filePath: string | null = null;
    try {
        filePath = await item.getFilePathAsync() || null;
    } catch (error) {
        return responseError(
            "extraction_failed",
            `Failed to resolve the EPUB attachment file path: ${getErrorMessage(error)}`,
        );
    }

    if (!filePath) {
        let remoteAvailable = false;
        try {
            remoteAvailable = isRemoteAccessAvailable(item);
        } catch {
            remoteAvailable = false;
        }

        if (remoteAvailable) {
            try {
                options?.onFileNotSyncedLocally?.();
            } catch {
                // Notification callbacks must never change extraction results.
            }
            return responseError(
                "file_missing",
                "The EPUB file is available remotely but is not synced locally. Sync it in Zotero so Beaver can read it.",
            );
        }

        return responseError("file_missing", "The EPUB file is not available locally.");
    }

    const maxFileSizeMB = effectiveMaxFileSizeMB(options?.maxFileSizeMB);
    try {
        const stat = await IOUtils.stat(filePath);
        const sizeMB = typeof stat.size === "number" ? stat.size / 1024 / 1024 : null;
        if (sizeMB != null && sizeMB > maxFileSizeMB) {
            return responseError(
                "file_too_large",
                `The EPUB file is ${formatMB(sizeMB)} MB, which exceeds the ${formatMB(maxFileSizeMB)} MB limit.`,
            );
        }
    } catch (error) {
        if ((error as { name?: string } | null)?.name === "NotFoundError") {
            return responseError("file_missing", "The EPUB file is no longer available locally.");
        }
        return responseError(
            "extraction_failed",
            `Failed to inspect the EPUB file: ${getErrorMessage(error)}`,
        );
    }

    try {
        return { kind: "ok", document: await extractEpubDocument(item) };
    } catch (error) {
        return responseError("extraction_failed", `Failed to extract EPUB content: ${getErrorMessage(error)}`);
    }
}

function isEpubAttachment(item: Zotero.Item): boolean {
    const maybeItem = item as Zotero.Item & {
        isEPUBAttachment?: () => boolean;
        attachmentContentType?: string;
    };
    if (typeof maybeItem.isEPUBAttachment === "function") {
        return maybeItem.isEPUBAttachment();
    }
    return maybeItem.attachmentContentType === "application/epub+zip";
}
