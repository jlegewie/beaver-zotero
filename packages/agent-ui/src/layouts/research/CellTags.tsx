import React, { useMemo } from "react";
import type { Cell, Evidence, Row } from "@beaver/agent-core/layouts/table";
import {
    citationForEvidence,
    rowReference,
} from "@beaver/agent-core/layouts/tableCitations";
import type { ContentKind } from "@beaver/agent-core/types/citations";
import { useCitationActivation } from "../../chat/Citation";
import {
    AlertCircleIcon,
    ArrowUpRightIcon,
    EditIcon,
    FileIcon,
    Icon,
    RepeatIcon,
} from "../../icons";
import { useHoverAnchor } from "../../primitives/HoverLayer";
import {
    cellTags,
    documentKindLabel,
    evidenceTagLabel,
    tagDefinition,
    type CellTag,
    type TableDocuments,
} from "./cellModel";

/**
 * The inline tags after a cell's text: a page tag per cited passage and the
 * status tags (Abstract, Out of date, Edited, No passage), in the order
 * {@link cellTags} gives.
 */
export function CellTags({
    row,
    cell,
    documents,
    className,
}: {
    row: Row;
    cell: Cell | undefined;
    documents?: TableDocuments;
    className?: string;
}): React.ReactElement | null {
    const tags = cellTags(row, cell);
    if (!tags.length || !cell) return null;
    const evidence = cell.evidence ?? [];
    return (
        <span className={`rt-tags${className ? ` ${className}` : ""}`}>
            {tags.map((tag) =>
                tag.kind === "page" ? (
                    <EvidenceTag
                        key={`page-${tag.evidence}`}
                        row={row}
                        evidence={evidence[tag.evidence]}
                        index={tag.evidence}
                        count={evidence.length}
                        documents={documents}
                    />
                ) : (
                    <StatusTag key={tag.kind} tag={tag} cell={cell} />
                ),
            )}
        </span>
    );
}

const STATUS_LABEL: Record<Exclude<CellTag, { kind: "page" }>["kind"], string> = {
    abstract: "Abstract",
    stale: "Out of date",
    edited: "Edited",
    no_passage: "No passage",
};

const STATUS_ICON: Record<
    Exclude<CellTag, { kind: "page" }>["kind"],
    React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
    abstract: FileIcon,
    stale: RepeatIcon,
    edited: EditIcon,
    no_passage: AlertCircleIcon,
};

/** A status tag, whose tooltip is its definition. */
export function StatusTag({
    tag,
    cell,
}: {
    tag: Exclude<CellTag, { kind: "page" }>;
    cell: Cell | undefined;
}): React.ReactElement {
    const definition = tagDefinition(tag, cell);
    const hover = useHoverAnchor({
        slot: "card",
        variant: "tip",
        width: 248,
        render: () => definition,
    });
    return (
        <span
            className={`rt-tag rt-tag-${tag.kind}`}
            tabIndex={0}
            aria-label={`${STATUS_LABEL[tag.kind]}: ${definition}`}
            {...hover}
        >
            <Icon icon={STATUS_ICON[tag.kind]} size={10} />
            {STATUS_LABEL[tag.kind]}
        </span>
    );
}

/** The citation for an evidence entry, with the document's kind when known. */
function useEvidenceCitation(row: Row, evidence: Evidence, documents?: TableDocuments) {
    const kind = documents?.get(evidence.document)?.kind;
    return useMemo(
        () =>
            citationForEvidence(
                row,
                evidence,
                kind ? { contentKind: kind as ContentKind } : {},
            ),
        [row, evidence, kind],
    );
}

/**
 * A cited passage's page tag: hovering shows the citation card, clicking opens
 * the passage. Both go through the chat's `Citation` activation, so the tag
 * opens the evidence's own document at its page and highlights the passage.
 */
export function EvidenceTag({
    row,
    evidence,
    index,
    count,
    documents,
}: {
    row: Row;
    evidence: Evidence;
    index: number;
    count: number;
    documents?: TableDocuments;
}): React.ReactElement {
    const citation = useEvidenceCitation(row, evidence, documents);
    const kind = documents?.get(evidence.document)?.kind;
    if (!citation)
        return (
            <span className="rt-tag rt-tag-page">
                {evidenceTagLabel(evidence, index, count, { kind })}
            </span>
        );
    return (
        <CitedEvidenceTag
            row={row}
            evidence={evidence}
            index={index}
            count={count}
            kind={kind}
            citation={citation}
        />
    );
}

function CitedEvidenceTag({
    row,
    evidence,
    index,
    count,
    kind,
    citation,
}: {
    row: Row;
    evidence: Evidence;
    index: number;
    count: number;
    kind: string | undefined;
    citation: NonNullable<ReturnType<typeof citationForEvidence>>;
}): React.ReactElement {
    const { vm, activate } = useCitationActivation(citation);
    const label = evidenceTagLabel(evidence, index, count, {
        kind,
        pageLabel: vm.pageLabels[0],
    });
    const hover = useHoverAnchor({
        slot: "card",
        variant: "card",
        width: 300,
        render: () => (
            <EvidenceCard
                row={row}
                evidence={evidence}
                label={label}
                kind={kind}
                onOpen={activate}
            />
        ),
    });
    return (
        <button
            type="button"
            className="rt-tag rt-tag-page"
            data-evidence-index={index}
            onClick={(event) => {
                event.stopPropagation();
                activate(event);
            }}
            {...hover}
        >
            {label}
        </button>
    );
}

/**
 * The page tag's hover card: where the passage is, the passage with its
 * table context, and a link that opens it.
 */
function EvidenceCard({
    row,
    evidence,
    label,
    kind,
    onOpen,
}: {
    row: Row;
    evidence: Evidence;
    label: string;
    kind: string | undefined;
    onOpen(source: { ownerDocument: Document }): void;
}): React.ReactElement {
    const work = rowReference(row)?.display_name;
    const where = label.startsWith("p. ")
        ? `Page ${label.slice(3)}`
        : label;
    return (
        <div className="rt-card rt-evidence-card">
            <div className="rt-card-meta">
                <Icon icon={FileIcon} size={12} />
                <span>{[where, work].filter(Boolean).join(" · ")}</span>
            </div>
            {evidence.context ? (
                <div className="rt-evidence-context">{evidence.context}</div>
            ) : null}
            <p className="rt-quote">“{evidence.quote.replace(/\s+/g, " ").trim()}”</p>
            <button
                type="button"
                className="rt-link-button"
                onClick={(event) => onOpen({ ownerDocument: event.currentTarget.ownerDocument })}
            >
                Open in {documentKindLabel(kind)}
                <Icon icon={ArrowUpRightIcon} size={12} />
            </button>
        </div>
    );
}

/**
 * A cited passage in the inspector: its tag and its quote, the whole entry a
 * button that opens the passage like the tag does.
 */
export function EvidencePassage({
    row,
    evidence,
    index,
    count,
    documents,
}: {
    row: Row;
    evidence: Evidence;
    index: number;
    count: number;
    documents?: TableDocuments;
}): React.ReactElement {
    const citation = useEvidenceCitation(row, evidence, documents);
    const kind = documents?.get(evidence.document)?.kind;
    const body = (label: string) => (
        <>
            <span className="rt-tag rt-tag-page">{label}</span>
            <span className="rt-passage-text">
                {evidence.context ? (
                    <span className="rt-evidence-context">{evidence.context}</span>
                ) : null}
                “{evidence.quote.replace(/\s+/g, " ").trim()}”
            </span>
        </>
    );
    if (!citation)
        return <div className="rt-passage">{body(evidenceTagLabel(evidence, index, count, { kind }))}</div>;
    return (
        <CitedPassage citation={citation} evidence={evidence} index={index} count={count} kind={kind} body={body} />
    );
}

function CitedPassage({
    citation,
    evidence,
    index,
    count,
    kind,
    body,
}: {
    citation: NonNullable<ReturnType<typeof citationForEvidence>>;
    evidence: Evidence;
    index: number;
    count: number;
    kind: string | undefined;
    body(label: string): React.ReactNode;
}): React.ReactElement {
    const { vm, activate } = useCitationActivation(citation);
    const label = evidenceTagLabel(evidence, index, count, { kind, pageLabel: vm.pageLabels[0] });
    return (
        <button
            type="button"
            className="rt-passage rt-passage-button"
            data-evidence-index={index}
            title={`Open in ${documentKindLabel(kind)}`}
            onClick={(event) => activate(event)}
        >
            {body(label)}
        </button>
    );
}
