import React from "react";
import { Icon, Spinner, UndoIcon } from "../../icons";

/** One saved version of a table, as the version history lists it. */
export interface TableVersionListEntry {
    version: number;
    /** What the write changed ("Added items"); absent on older entries. */
    change?: string;
    actor: "user" | "agent" | "system";
    /** ISO timestamp of the write. */
    at: string;
    /** Rows in that version, when known. */
    items?: number;
    /** Columns the user can see in that version (system columns excluded), when known. */
    columns?: number;
}

export interface VersionHistoryProps {
    /** Newest or oldest first; null while loading. */
    versions: TableVersionListEntry[] | null;
    /** The version the table shows now; it is marked Current and cannot be restored. */
    currentVersion?: number;
    /** Restores a version. Absent where restoring is not possible (a read-only library). */
    onRestore?: (version: number) => void;
    /** The version a restore is in progress for. */
    restoring?: number | null;
    /** Why restoring is unavailable right now (a fill is running); shown on the buttons. */
    restoreDisabledReason?: string;
    /** The outcome of the last restore. */
    status?: string | null;
    /** A load or restore failure. */
    error?: string | null;
    /** Replaces the closing note (why versions cannot be restored here). */
    note?: string;
}

const ACTORS: Record<TableVersionListEntry["actor"], string | null> = {
    user: "You",
    agent: "Beaver",
    system: null,
};

/** The change line of an entry, with a fallback for entries that recorded none. */
function versionTitle(entry: TableVersionListEntry): string {
    if (entry.change) return entry.change;
    return entry.actor === "agent" ? "Updated by Beaver" : entry.actor === "user" ? "Edited" : "Saved";
}

function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The day heading a version falls under: Today, Yesterday, or the date. */
function versionDay(at: Date, now: Date): string {
    const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return at.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    });
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface DayGroup {
    day: string;
    entries: { entry: TableVersionListEntry; time: string }[];
}

/** Newest first, grouped by day. An unparseable timestamp groups as "Earlier" and shows as stored. */
function groupByDay(versions: TableVersionListEntry[], now: Date): DayGroup[] {
    const groups: DayGroup[] = [];
    for (const entry of [...versions].sort((a, b) => b.version - a.version)) {
        const at = new Date(entry.at);
        const valid = !Number.isNaN(at.getTime());
        const day = valid ? versionDay(at, now) : "Earlier";
        const time = valid ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : entry.at;
        const last = groups[groups.length - 1];
        if (last?.day === day) last.entries.push({ entry, time });
        else groups.push({ day, entries: [{ entry, time }] });
    }
    return groups;
}

/**
 * A table's saved versions as a timeline, newest first and grouped by day.
 * Each version names what changed, when, who changed it and the table's size;
 * the current one is marked, every other one can be restored from its row.
 */
export function VersionHistory({
    versions,
    currentVersion,
    onRestore,
    restoring = null,
    restoreDisabledReason,
    status,
    error,
    note,
}: VersionHistoryProps): React.ReactElement {
    return (
        <div className="rt-history-content">
            {error ? (
                <div className="rt-inspector-failure" role="alert">
                    {error}
                </div>
            ) : null}
            {status ? (
                <p className="rt-history-status" role="status">
                    {status}
                </p>
            ) : null}
            {!versions ? (
                error ? null : (
                    <p className="rt-history-loading">
                        <Spinner size={12} />
                        Loading versions…
                    </p>
                )
            ) : !versions.length ? (
                <p className="rt-inspector-empty">No saved versions yet.</p>
            ) : (
                <VersionList
                    versions={versions}
                    currentVersion={currentVersion}
                    onRestore={onRestore}
                    restoring={restoring}
                    restoreDisabledReason={restoreDisabledReason}
                    note={note}
                />
            )}
        </div>
    );
}

function VersionList({
    versions,
    currentVersion,
    onRestore,
    restoring,
    restoreDisabledReason,
    note,
}: Omit<VersionHistoryProps, "versions" | "status" | "error"> & { versions: TableVersionListEntry[] }): React.ReactElement {
    const groups = groupByDay(versions, new Date());
    const busy = restoring !== null;
    return (
        <>
            {groups.map((group) => (
                <section key={group.day} className="rt-history-day" aria-label={group.day}>
                    <h2 className="rt-inspector-heading rt-history-day-heading">{group.day}</h2>
                    <ol className="rt-history-list">
                        {group.entries.map(({ entry, time }) => {
                            const current = entry.version === currentVersion;
                            const actor = ACTORS[entry.actor];
                            const details = [
                                time,
                                actor,
                                entry.items !== undefined ? plural(entry.items, "item") : null,
                                entry.columns !== undefined ? plural(entry.columns, "column") : null,
                            ].filter(Boolean);
                            const title = versionTitle(entry);
                            return (
                                <li
                                    key={entry.version}
                                    className={`rt-history-entry${current ? " rt-history-current" : ""}`}
                                    data-version={entry.version}
                                >
                                    <span className="rt-history-marker" aria-hidden="true" />
                                    <div className="rt-history-text">
                                        <div className="rt-history-title">
                                            <span className="rt-history-change">{title}</span>
                                            {current ? <span className="rt-history-badge">Current</span> : null}
                                        </div>
                                        <div className="rt-history-meta">
                                            {details.join(" · ")}
                                            <span className="rt-history-version"> · v{entry.version}</span>
                                        </div>
                                    </div>
                                    {!current && onRestore ? (
                                        <span className={`rt-history-actions${restoring === entry.version ? " rt-history-restoring" : ""}`}>
                                            <button
                                                type="button"
                                                className="rt-inspector-action rt-history-restore"
                                                aria-label={`Restore version ${entry.version}: ${title}`}
                                                title={restoreDisabledReason ?? `Restore version ${entry.version}`}
                                                disabled={busy || !!restoreDisabledReason}
                                                onClick={() => onRestore(entry.version)}
                                            >
                                                {restoring === entry.version ? <Spinner size={12} /> : <Icon icon={UndoIcon} size={12} />}
                                                Restore
                                            </button>
                                        </span>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ol>
                </section>
            ))}
            <p className="rt-inspector-note rt-history-note">
                {note ?? "Restoring a version saves it as a new version, so the current table stays in this history."}
            </p>
        </>
    );
}
