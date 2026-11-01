import {
  type ExtractContentKind,
  isExtractContentKind,
} from "@beaver/agent-core/extract/document/shared/contentKinds";

export interface IndexBackgroundJobMetadata {
  /** Explicit local preparation stops claiming files when the cache fills. */
  prepare_cache?: boolean;
  /** Semantic OCR admission intent; absent legacy values remain backfill. */
  request_context?: "interactive" | "backfill";
  /** Frozen remote identity for cleanup, independent of later account/library changes. */
  index_account_id?: string;
  /** Diagnostic label only; all removals check whether membership is still wanted. */
  index_cleanup_reason?: "replacement" | "stale_completion" | "exclusion";
  index_scope_ref?: string;
  index_local_id?: string;
  /** Set once the cleanup's owner queued a reacquisition of this membership. */
  index_reacquire_attempted?: boolean;
  index_action?: "upsert" | "untag";
  /** Hash to untag for a delete/replacement operation. */
  doc_hash?: string;
}

export interface PdfBackgroundJobPayload extends IndexBackgroundJobMetadata {
  content_kind: "pdf";
  maxPages: number | null;
  timeoutSeconds: number;
}

export interface EpubBackgroundJobPayload extends IndexBackgroundJobMetadata {
  content_kind: "epub";
}

export interface TextBackgroundJobPayload extends IndexBackgroundJobMetadata {
  content_kind: "text";
}

export interface SnapshotBackgroundJobPayload extends IndexBackgroundJobMetadata {
  content_kind: "snapshot";
}

export type BackgroundJobPayload =
  | PdfBackgroundJobPayload
  | EpubBackgroundJobPayload
  | TextBackgroundJobPayload
  | SnapshotBackgroundJobPayload;

/**
 * Parse a queue payload and reject rows whose column kind and JSON
 * discriminator disagree.
 */
export function parseBackgroundJobPayload(
  contentKind: string | null | undefined,
  json: string | null | undefined,
): BackgroundJobPayload | null {
  if (!contentKind || !isExtractContentKind(contentKind) || !json) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const discriminator = (parsed as { content_kind?: unknown }).content_kind;
  if (discriminator !== contentKind || typeof discriminator !== "string") {
    return null;
  }
  if (!isExtractContentKind(discriminator)) {
    return null;
  }

  switch (discriminator as ExtractContentKind) {
    case "pdf": {
      const payload = parsed as Partial<PdfBackgroundJobPayload>;
      const maxPagesValid =
        payload.maxPages === null || typeof payload.maxPages === "number";
      if (!maxPagesValid || typeof payload.timeoutSeconds !== "number") {
        return null;
      }
      return payload as PdfBackgroundJobPayload;
    }
    case "epub":
    case "text":
    case "snapshot":
      return parsed as BackgroundJobPayload;
  }
}
