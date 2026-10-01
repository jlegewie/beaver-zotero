import React from 'react';
import type { DuplicateGroup, DuplicateMember } from '@beaver/agent-core/protocol/duplicates';
import { formatFieldName } from '../../../utils/fieldLabels';

/**
 * Presentation helpers shared by the duplicate-finding result view and the
 * merge approval preview. Members are referred to by letter (A, B, …) in both
 * surfaces so a field comparison can point back at its record without keys.
 */

/**
 * Bookkeeping dates Zotero's own merge pane leaves out of its comparison: they
 * differ between any two imports of the same work and say nothing about which
 * record is right.
 */
export const MERGE_IGNORED_FIELDS = new Set(['dateAdded', 'dateModified', 'accessDate']);

/** Differing fields worth showing a reader, in the order they arrived. */
export function comparableFields(group: DuplicateGroup): string[] {
    return group.differing_fields.filter((f) => !MERGE_IGNORED_FIELDS.has(f));
}

export function memberLetter(index: number): string {
    return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** Single field value as display text; `null` for an empty value. */
export function duplicateFieldText(value: unknown): string | null {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
        // Zotero stores access dates as UTC ISO timestamps.
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
            const date = new Date(value);
            if (!Number.isNaN(date.getTime())) {
                return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            }
        }
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return null;
        return value.map(creatorText).join('; ');
    }
    return JSON.stringify(value);
}

/** "Gary King", or "Gary King (Editor)" for any role other than author. */
function creatorText(creator: unknown): string {
    if (!creator || typeof creator !== 'object') return String(creator);
    const c = creator as { firstName?: string; lastName?: string; name?: string; creatorType?: string };
    const name = [c.firstName, c.lastName || c.name].filter(Boolean).join(' ');
    return c.creatorType && c.creatorType !== 'author' ? `${name} (${formatFieldName(c.creatorType)})` : name;
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * Identity of a field value for grouping records that share it. Compares the
 * underlying value, not its display text, which drops detail (creator field
 * mode, formatting) and would merge values that differ. All empty forms are
 * one value.
 */
export function fieldValueKey(value: unknown): string {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return '';
    return stableStringify(value);
}

export function hasMixedItemTypes(group: DuplicateGroup): boolean {
    return new Set(group.members.map((m) => m.item_type)).size > 1;
}

/**
 * "King and Nielsen · 2019", or null when the record has neither. With
 * `withType`, the item type leads ("Book · Müller · 2015") so records of a
 * mixed-type group can be told apart.
 */
export function memberByline(member: DuplicateMember, withType = false): string | null {
    const year = member.date.match(/\b(\d{4})\b/)?.[1] ?? member.date;
    const type = withType ? formatFieldName(member.item_type) : null;
    const parts = [type, member.creators, year].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
}

function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** What merging would carry over from this record: attachments, notes, annotations. */
export function memberContents(member: DuplicateMember): string {
    const annotations = (member.children ?? []).reduce((sum, c) => sum + (c.annotation_count || 0), 0);
    const parts: string[] = [];
    if (member.attachment_count) parts.push(plural(member.attachment_count, 'attachment'));
    if (member.note_count) parts.push(plural(member.note_count, 'note'));
    if (annotations) parts.push(plural(annotations, 'annotation'));
    return parts.length ? parts.join(' · ') : 'No attachments or notes';
}

/**
 * "Added Feb 6, 2026" from Zotero's UTC `dateAdded` ("YYYY-MM-DD HH:MM:SS").
 * With `withTime`, the local time of day follows when the value has one.
 */
export function memberDateAdded(member: DuplicateMember, withTime = false): string | null {
    const raw = member.date_added;
    const match = raw?.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/);
    if (!match) return null;
    const date = new Date(`${match[1]}T${match[2] ?? '00:00:00'}Z`);
    if (Number.isNaN(date.getTime())) return null;
    const timed = withTime && !!match[2];
    const formatted = date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: timed ? 'numeric' : undefined,
        minute: timed ? '2-digit' : undefined,
        // A date-only value has no time of day to shift into local time.
        timeZone: match[2] ? undefined : 'UTC',
    });
    return `Added ${formatted}`;
}

/** Whether records' bylines tell them apart (or their item types differ). */
export function showsBylines(group: DuplicateGroup): boolean {
    return hasMixedItemTypes(group) || new Set(group.members.map((m) => memberByline(m))).size > 1;
}

export interface MemberLines {
    primary: string;
    secondary: string | null;
}

/**
 * Two lines identifying a record within its group. The byline leads only when
 * it tells the records apart; otherwise date added does, with the contents
 * below. Duplicates usually share author and year, so repeating them per
 * record adds nothing.
 */
export function memberLines(
    member: DuplicateMember,
    showByline: boolean,
    withType: boolean,
    withTime = false,
): MemberLines {
    const primary = [showByline ? memberByline(member, withType) : null, memberDateAdded(member, withTime)]
        .filter(Boolean)
        .join(' · ');
    return primary
        ? { primary, secondary: memberContents(member) }
        : { primary: memberContents(member), secondary: null };
}

function linesDistinct(lines: MemberLines[]): boolean {
    return new Set(lines.map((l) => `${l.primary}\n${l.secondary ?? ''}`)).size === lines.length;
}

/**
 * `memberLines` for every record of a group, guaranteed distinct so a reader
 * can tell which record they are choosing. Records imported on the same day
 * with the same contents would otherwise read alike; the first detail that
 * separates them is added to every row: time added, then title, then the
 * item key.
 */
export function groupMemberLines(group: DuplicateGroup): MemberLines[] {
    const showByline = showsBylines(group);
    const withType = hasMixedItemTypes(group);
    const base = group.members.map((m) => memberLines(m, showByline, withType));
    if (linesDistinct(base)) return base;

    const timed = group.members.map((m) => memberLines(m, showByline, withType, true));
    if (linesDistinct(timed)) return timed;

    const titled = group.members.map((m, i) => ({
        primary: m.title || base[i].primary,
        secondary: [base[i].primary, base[i].secondary].filter(Boolean).join(' · ') || null,
    }));
    if (linesDistinct(titled)) return titled;

    return group.members.map((m, i) => ({ ...timed[i], primary: `${timed[i].primary} · ${m.zotero_key}` }));
}

/** Record letter; announced as "Record A" since it links values to their record. */
export const MemberBadge: React.FC<{ index: number }> = ({ index }) => (
    <span className="duplicate-member-badge">
        <span className="sr-only">Record </span>
        {memberLetter(index)}
    </span>
);

/** Field value clamped to a few lines; empty values render as a muted placeholder. */
export const FieldValue: React.FC<{ value: unknown; lines?: number }> = ({ value, lines = 3 }) => {
    const text = duplicateFieldText(value);
    if (text == null) return <span className="font-color-secondary font-italic">Empty</span>;
    return (
        <span className="duplicate-field-value" style={{ WebkitLineClamp: lines }} title={text}>
            {text}
        </span>
    );
};

export interface FieldValueGroup {
    /** Records holding this value. */
    indices: number[];
    value: unknown;
    /** Identity of the underlying value; empty for any empty form. */
    key: string;
    text: string | null;
}

/** Distinct values of one field across a group, each with the records holding it. */
export function groupFieldValues(group: DuplicateGroup, field: string): FieldValueGroup[] {
    const values: FieldValueGroup[] = [];
    group.members.forEach((member, index) => {
        const value = member.fields[field];
        const key = fieldValueKey(value);
        const existing = values.find((v) => v.key === key);
        if (existing) existing.indices.push(index);
        else values.push({ indices: [index], value, key, text: duplicateFieldText(value) });
    });
    return values;
}
