/**
 * Build an export source from agent run history.
 *
 * Exports work from the raw model output persisted in `run.model_messages`
 * (markdown with citation tags), not from anything rendered. A response is
 * exported either as its final answer — what the agent wrote after its last
 * tool call — or in full: everything it wrote, with each tool call as a short
 * activity line so the reader can follow what it searched and read. Reasoning
 * and tool results are never exported.
 */

import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { isAutoLoadingToolCall, isRenderableMessage } from '@beaver/agent-core/agents/messageVisibility';
import { parseArgs } from '@beaver/agent-core/run-state/toolCallRequest';
import type { CitationSnapshot, ExportContent, ExportSource, ExportSourceBlock } from '../types';
import { codeRanges } from '../parse/markdown';

export interface ResponseBlockOptions {
    /** Include notes the agent created (`create_note`) as sections. Default true. */
    includeNotes?: boolean;
    /** The final answer only, or the full response. Default `full`. */
    content?: ExportContent;
    /**
     * Display label of a tool call for full-response exports, or null to leave
     * the call out. Without it, tool calls are not shown.
     */
    describeToolCall?: (part: ToolCallPart) => string | null;
}

/** One step of a response, in order. */
type ResponseEvent =
    | { kind: 'text'; markdown: string }
    | { kind: 'note'; title: string; markdown: string }
    | { kind: 'toolCall'; part: ToolCallPart };

export interface ThreadBlockOptions extends ResponseBlockOptions {
    /** Include each run's user prompt. Default true. */
    includeUserPrompts?: boolean;
}

/** `<note title="…">…</note>` sections inside assistant text. */
const NOTE_TAG_PATTERN = /<note\b([^>]*)>([\s\S]*?)(?:<\/note>|$)/g;
const TITLE_ATTR_PATTERN = /\btitle\s*=\s*"([^"]*)"/;

function pushMarkdown(blocks: ExportSourceBlock[], markdown: string): void {
    if (!markdown.trim()) return;
    const last = blocks[blocks.length - 1];
    if (last?.type === 'markdown') {
        last.markdown = `${last.markdown}\n\n${markdown}`;
    } else {
        blocks.push({ type: 'markdown', markdown });
    }
}

/** The text with every code character except line breaks replaced by a space. */
function maskCode(text: string): string {
    let masked = '';
    let cursor = 0;
    for (const [start, end] of codeRanges(text)) {
        if (start < cursor) continue;
        masked += text.slice(cursor, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
        cursor = end;
    }
    return masked + text.slice(cursor);
}

/** Split assistant text into plain markdown and the `<note>` sections it contains. */
export function splitNoteTags(text: string, includeNotes: boolean): ExportSourceBlock[] {
    const blocks: ExportSourceBlock[] = [];
    let cursor = 0;
    // A `<note>` written inside code is an example, not a note. Tags are matched
    // on a copy with code blanked out (offsets unchanged), so neither an opening
    // nor a closing tag in code can pair with a real one; text is taken from the
    // original.
    const masked = text.includes('<note') ? maskCode(text) : text;
    for (const match of masked.matchAll(NOTE_TAG_PATTERN)) {
        const start = match.index ?? 0;
        pushMarkdown(blocks, text.slice(cursor, start));
        cursor = start + match[0].length;
        // A matched opening tag lies outside code, so its attributes read the same in both.
        const title = TITLE_ATTR_PATTERN.exec(match[1] ?? '')?.[1]?.trim() ?? '';
        const bodyStart = start + match[0].indexOf('>') + 1;
        const body = text.slice(bodyStart, bodyStart + (match[2]?.length ?? 0));
        if (!body.trim()) continue;
        if (includeNotes) {
            blocks.push({ type: 'note', title, markdown: body });
        } else {
            pushMarkdown(blocks, body);
        }
    }
    pushMarkdown(blocks, text.slice(cursor));
    return blocks;
}

/** The note a `create_note` call wrote, or null for any other call. */
export function noteFromToolCall(part: ToolCallPart): { title: string; markdown: string } | null {
    if (part.tool_name !== 'create_note') return null;
    const args = parseArgs(part);
    const markdown = typeof args.content === 'string' ? args.content : '';
    if (!markdown.trim()) return null;
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    return { title, markdown };
}

/** The text, notes and tool calls of a response, in order. */
function responseEvents(runs: AgentRun[], includeNotes: boolean): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    for (const run of runs) {
        for (const message of run.model_messages) {
            if (!isRenderableMessage(message)) continue;
            for (const part of message.parts) {
                if (part.part_kind === 'text') {
                    for (const block of splitNoteTags(part.content ?? '', includeNotes)) {
                        if (block.type === 'markdown') events.push({ kind: 'text', markdown: block.markdown });
                        else if (block.type === 'note') events.push({ kind: 'note', title: block.title, markdown: block.markdown });
                    }
                } else if (part.part_kind === 'tool-call') {
                    // Follow-up suggestions and backend plumbing are neither work nor content.
                    if (part.tool_name === 'return_suggestions' || isAutoLoadingToolCall(part)) continue;
                    // A note the agent wrote is content, not activity.
                    const note = noteFromToolCall(part);
                    if (note) {
                        if (includeNotes) events.push({ kind: 'note', ...note });
                    } else {
                        events.push({ kind: 'toolCall', part });
                    }
                }
            }
        }
    }
    return events;
}

/**
 * The final answer: what follows the last tool call. When a response ends
 * with a tool call (a canceled run), the answer is the last stretch of text
 * and notes between tool calls that has any content, kept whole.
 */
function finalAnswer(events: ResponseEvent[]): ResponseEvent[] {
    const segments: ResponseEvent[][] = [[]];
    for (const event of events) {
        if (event.kind === 'toolCall') segments.push([]);
        else segments[segments.length - 1].push(event);
    }
    const hasContent = (segment: ResponseEvent[]) =>
        segment.some(event => event.kind !== 'toolCall' && event.markdown.trim());
    return [...segments].reverse().find(hasContent) ?? [];
}

/**
 * The blocks of one response. A response that was continued after an error
 * spans several runs (its resume chain); pass them in order.
 */
export function buildResponseBlocks(
    runs: AgentRun[],
    options: ResponseBlockOptions = {},
): ExportSourceBlock[] {
    const events = responseEvents(runs, options.includeNotes ?? true);
    const selected = (options.content ?? 'full') === 'final' ? finalAnswer(events) : events;
    const blocks: ExportSourceBlock[] = [];
    for (const event of selected) {
        if (event.kind === 'text') {
            pushMarkdown(blocks, event.markdown);
        } else if (event.kind === 'note') {
            blocks.push({ type: 'note', title: event.title, markdown: event.markdown });
        } else {
            const label = options.describeToolCall?.(event.part)?.trim();
            if (!label) continue;
            // Consecutive tool calls form one activity block.
            const last = blocks[blocks.length - 1];
            if (last?.type === 'activity') last.calls.push(label);
            else blocks.push({ type: 'activity', calls: [label] });
        }
    }
    return blocks.map(block => (block.type === 'activity' ? { ...block, calls: collapseRepeats(block.calls) } : block));
}

/** Runs of the same call label as one line with a count (`Create collection ×10`). */
function collapseRepeats(calls: string[]): string[] {
    const out: string[] = [];
    let index = 0;
    while (index < calls.length) {
        let end = index + 1;
        while (end < calls.length && calls[end] === calls[index]) end++;
        out.push(end - index > 1 ? `${calls[index]} ×${end - index}` : calls[index]);
        index = end;
    }
    return out;
}

/** The blocks of a whole thread: each run's prompt followed by its response. */
export function buildThreadBlocks(
    runs: AgentRun[],
    options: ThreadBlockOptions = {},
): ExportSourceBlock[] {
    const includeUserPrompts = options.includeUserPrompts ?? true;
    const blocks: ExportSourceBlock[] = [];
    for (const run of runs) {
        // A continuation run carries no prompt of its own.
        const prompt = run.user_prompt?.content?.trim();
        if (includeUserPrompts && prompt) blocks.push({ type: 'user', text: prompt });
        blocks.push(...buildResponseBlocks([run], options));
    }
    return blocks;
}

export interface BuildSourceInput {
    kind: ExportSource['kind'];
    title: string;
    blocks: ExportSourceBlock[];
    citations: CitationSnapshot;
    threadId?: string | null;
    runIds: string[];
}

export function buildExportSource(input: BuildSourceInput): ExportSource {
    return {
        kind: input.kind,
        title: input.title,
        blocks: input.blocks,
        citations: input.citations,
        provenance: { threadId: input.threadId ?? null, runIds: input.runIds },
    };
}
