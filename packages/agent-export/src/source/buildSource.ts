/**
 * Build an export source from agent run history.
 *
 * Exports work from the raw model output persisted in `run.model_messages`
 * (markdown with citation tags), not from anything rendered. Only content a
 * reader sees as the answer is exported: assistant text, and the notes the
 * agent wrote. Reasoning, tool calls and their results are left out.
 */

import type { AgentRun, ToolCallPart } from '@beaver/agent-core/agents/types';
import { isRenderableMessage } from '@beaver/agent-core/agents/messageVisibility';
import { parseArgs } from '@beaver/agent-core/run-state/toolCallRequest';
import type { CitationSnapshot, ExportSource, ExportSourceBlock } from '../types';
import { codeRanges } from '../parse/markdown';

export interface ResponseBlockOptions {
    /** Include notes the agent created (`create_note`) as sections. Default true. */
    includeNotes?: boolean;
}

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

/**
 * The blocks of one response. A response that was continued after an error
 * spans several runs (its resume chain); pass them in order.
 */
export function buildResponseBlocks(
    runs: AgentRun[],
    options: ResponseBlockOptions = {},
): ExportSourceBlock[] {
    const includeNotes = options.includeNotes ?? true;
    const blocks: ExportSourceBlock[] = [];
    for (const run of runs) {
        for (const message of run.model_messages) {
            if (!isRenderableMessage(message)) continue;
            for (const part of message.parts) {
                if (part.part_kind === 'text') {
                    for (const block of splitNoteTags(part.content ?? '', includeNotes)) {
                        if (block.type === 'markdown') pushMarkdown(blocks, block.markdown);
                        else blocks.push(block);
                    }
                } else if (part.part_kind === 'tool-call' && includeNotes) {
                    const note = noteFromToolCall(part);
                    if (note) blocks.push({ type: 'note', ...note });
                }
            }
        }
    }
    return blocks;
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
        if (includeUserPrompts && prompt) blocks.push({ type: 'user', markdown: prompt });
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
