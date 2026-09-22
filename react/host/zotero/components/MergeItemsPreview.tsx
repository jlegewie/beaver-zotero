import React, { useId } from "react";
import { useAtom, useAtomValue } from "jotai";
import type {
    MergeItemsProposedData,
    MergeItemsResultData,
} from "@beaver/agent-core/protocol/duplicates";
import { inFlightAgentActionIdsAtom } from "../agentActionExecution";
import {
    mergeItemsChoicesAtom,
    updateMergeItemsChoices,
} from "../../../atoms/mergeItemsChoices";
import { duplicateFieldText } from "../../../components/agentRuns/toolResultViews/DuplicatesResultView";

export const MergeItemsPreview: React.FC<{
    actionId?: string;
    data: MergeItemsProposedData;
    result?: MergeItemsResultData;
    editable: boolean;
    compact?: boolean;
}> = ({ actionId, data, result, editable, compact = false }) => {
    const radioGroupId = useId();
    const inFlight = useAtomValue(inFlightAgentActionIdsAtom);
    const [drafts, setDrafts] = useAtom(mergeItemsChoicesAtom);
    const group = result?.preview ?? data.preview;
    if (!group)
        return (
            <div className="p-3 text-sm font-color-secondary">
                Preparing merge preview…
            </div>
        );
    const choices =
        actionId && drafts[actionId]
            ? drafts[actionId]
            : {
                  master_item_id: data.master_item_id,
                  field_sources: data.field_sources ?? {},
                  creators_source_item_id: data.creators_source_item_id,
              };
    const masterID = result?.master_item_id ?? choices.master_item_id;
    const master =
        group.members.find((m) => m.item_id === masterID) ?? group.members[0];
    const otherCount = group.members.length - 1;
    const canEdit =
        editable && !!actionId && !result && !inFlight.has(actionId);
    const update = (patch: Partial<typeof choices>) => {
        if (actionId)
            setDrafts((prev) => ({
                ...prev,
                [actionId]: updateMergeItemsChoices(
                    prev[actionId],
                    choices,
                    patch,
                ),
            }));
    };
    if (compact)
        return (
            <div
                className="px-3 py-2 text-xs"
                data-testid="merge-items-summary"
            >
                <div>
                    <span className="font-medium">
                        {result ? "Kept" : "Keep"}:{" "}
                    </span>
                    {master.title} · {master.zotero_key}
                </div>
                <div className="font-color-secondary">
                    {otherCount} other {otherCount === 1 ? "record" : "records"} ·{" "}
                    {group.differing_fields.length} differing fields
                </div>
                {group.warnings.map((warning) => (
                    <div key={warning} role="note">
                        {warning}
                    </div>
                ))}
            </div>
        );
    return (
        <div
            className="p-3 text-sm display-flex flex-col gap-2"
            data-testid="merge-items-preview"
        >
            <div className="font-medium">
                {result ? "Kept record" : "Keep this record"}
            </div>
            {group.members.map((member) => (
                <label
                    key={member.item_id}
                    className="p-2 rounded-md display-flex gap-2"
                    style={{
                        background:
                            member.item_id === masterID
                                ? "var(--fill-quinary)"
                                : "transparent",
                        border:
                            member.item_id === masterID
                                ? "1px solid var(--fill-primary)"
                                : "1px solid transparent",
                    }}
                >
                    <input
                        type="radio"
                        name={`merge-master-${radioGroupId}`}
                        aria-label={`Keep ${member.title} (${member.zotero_key})`}
                        checked={member.item_id === masterID}
                        disabled={!canEdit}
                        onChange={() =>
                            update({ master_item_id: member.item_id })
                        }
                    />
                    <span>
                        <span className="font-medium">{member.title}</span>
                        <span
                            className="text-xs font-color-secondary"
                            style={{ display: "block" }}
                        >
                            {member.creators} · {member.date} ·{" "}
                            {member.zotero_key}
                        </span>
                        <span
                            className="text-xs font-color-secondary"
                            style={{ display: "block" }}
                        >
                            {member.attachment_count} attachments ·{" "}
                            {member.note_count} notes
                        </span>
                    </span>
                </label>
            ))}
            <div className="text-xs font-color-secondary">
                Collections and tags are combined. Zotero consolidates
                attachments and moves notes and annotations. The other{" "}
                {otherCount} {otherCount === 1 ? "record goes" : "records go"} to Trash. This merge can
                be undone from Changes.
            </div>
            {group.warnings.map((w) => (
                <div
                    key={w}
                    role="note"
                    className="text-xs font-color-secondary"
                >
                    {w}
                </div>
            ))}
            {group.differing_fields.map((field) => {
                const sourceID =
                    field === "creators"
                        ? choices.creators_source_item_id || masterID
                        : choices.field_sources?.[field] || masterID;
                const source =
                    group.members.find((m) => m.item_id === sourceID) ?? master;
                return (
                    <div key={field} className="border-top-quinary pt-2">
                        <label className="text-xs font-medium">
                            {field}
                            {canEdit && (
                                <select
                                    aria-label={`Source for ${field}`}
                                    value={sourceID}
                                    className="ml-2"
                                    onChange={(e) =>
                                        update(
                                            field === "creators"
                                                ? {
                                                      creators_source_item_id:
                                                          e.target.value,
                                                  }
                                                : {
                                                      field_sources: {
                                                          [field]:
                                                              e.target.value,
                                                      },
                                                  },
                                        )
                                    }
                                >
                                    {group.members.map((m) => (
                                        <option
                                            key={m.item_id}
                                            value={m.item_id}
                                        >
                                            {m.zotero_key}
                                            {m.item_id === masterID
                                                ? " (master)"
                                                : ""}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </label>
                        <div
                            className="text-xs mt-1"
                            style={{
                                whiteSpace: "pre-wrap",
                                overflowWrap: "anywhere",
                            }}
                        >
                            {duplicateFieldText(
                                result
                                    ? result.changes.find(
                                          (c) =>
                                              c.item_id ===
                                              result.master_item_id,
                                      )?.after[field]
                                    : source.fields[field],
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
