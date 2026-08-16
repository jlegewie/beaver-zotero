import React, { useCallback, useState } from "react";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink, SectionHeader, SectionDescription} from "./components/SettingsElements";
import DeferredToolPreferenceSetting from "./DeferredToolPreferenceSetting";
import { getPref, setPref } from "../../../src/utils/prefs";


const PermissionsSection: React.FC = () => {

    // --- Atoms: Permissions ---
    const [autoApplyAnnotations, setAutoApplyAnnotations] = useState(() => getPref('autoApplyAnnotations'));
    const [autoCreateNotes, setAutoCreateNotes] = useState(() => getPref('autoCreateNotes'));
    const [confirmCredits, setConfirmCredits] = useState(() => getPref('confirmCredits'));
    const [creditThresholdText, setCreditThresholdText] = useState(() => String(getPref('creditConfirmThreshold')));
    const [enableSystemNotifications, setEnableSystemNotifications] = useState(() => getPref('enableSystemNotifications'));
    const [enableResponseCompleteNotifications, setEnableResponseCompleteNotifications] = useState(() => getPref('enableResponseCompleteNotifications'));
    const [pauseLongRunningAgent, setPauseLongRunningAgent] = useState(() => getPref('pauseLongRunningAgent'));
    const [accessRemoteFiles, setAccessRemoteFiles] = useState(() => getPref('accessRemoteFiles'));

    // --- Handle Auto-Apply Annotations Toggle ---
    const handleAutoApplyAnnotationsToggle = useCallback(() => {
        const newValue = !autoApplyAnnotations;
        setPref('autoApplyAnnotations', newValue);
        setAutoApplyAnnotations(newValue);
    }, [autoApplyAnnotations]);

    // --- Handle Auto-Create Notes Toggle ---
    const handleAutoCreateNotesToggle = useCallback(() => {
        const newValue = !autoCreateNotes;
        setPref('autoCreateNotes', newValue);
        setAutoCreateNotes(newValue);
    }, [autoCreateNotes]);

    // --- Handle Confirm Credit Use Toggle ---
    const handleConfirmCreditsToggle = useCallback(() => {
        const newValue = !confirmCredits;
        setPref('confirmCredits', newValue);
        setConfirmCredits(newValue);
    }, [confirmCredits]);

    // --- Handle Credit Confirmation Limit ---
    // The field is edited as free text and only written on commit (blur or
    // Enter): writing per keystroke would store "1" on the way to "10", and an
    // empty field mid-edit is not a limit. A value that is not a non-negative
    // number is rejected and the field snaps back to the stored preference.
    const commitCreditThreshold = useCallback(() => {
        const parsed = Number(creditThresholdText.trim());
        if (creditThresholdText.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
            setCreditThresholdText(String(getPref('creditConfirmThreshold')));
            return;
        }
        setPref('creditConfirmThreshold', parsed);
        setCreditThresholdText(String(parsed));
    }, [creditThresholdText]);

    // --- Handle System Notifications Toggle ---
    const handleEnableSystemNotificationsToggle = useCallback(() => {
        const newValue = !enableSystemNotifications;
        setPref('enableSystemNotifications', newValue);
        setEnableSystemNotifications(newValue);
    }, [enableSystemNotifications]);

    // --- Handle Response Complete Notifications Toggle ---
    const handleEnableResponseCompleteNotificationsToggle = useCallback(() => {
        const newValue = !enableResponseCompleteNotifications;
        setPref('enableResponseCompleteNotifications', newValue);
        setEnableResponseCompleteNotifications(newValue);
    }, [enableResponseCompleteNotifications]);

    // --- Handle Pause Long-Running Agent Toggle ---
    const handlePauseLongRunningAgentToggle = useCallback(() => {
        const newValue = !pauseLongRunningAgent;
        setPref('pauseLongRunningAgent', newValue);
        setPauseLongRunningAgent(newValue);
    }, [pauseLongRunningAgent]);

    // --- Handle Access Remote Files Toggle ---
    const handleAccessRemoteFilesToggle = useCallback(() => {
        const newValue = !accessRemoteFiles;
        setPref('accessRemoteFiles', newValue);
        setAccessRemoteFiles(newValue);
    }, [accessRemoteFiles]);

    return (
        <>
            <SectionHeader>Library Modifications</SectionHeader>
            <SectionDescription>
                When Beaver modifies your library, all changes require your approval by default (the only exception is when Beaver creates a new note).
                You can change this behavior here. Be careful, Beaver might make changes you didn't expect.

                For more details, see documentation on <DocLink path="editing-metadata">editing metadata</DocLink> and <DocLink path="library-management">organizing your library items</DocLink>.
            </SectionDescription>
            <SettingsGroup>
                <div style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="edit_metadata"
                        label="Metadata Edits"
                        description="Changes to item titles, authors, abstracts, and other metadata"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_note"
                        label="Note Creation"
                        description="Creating new Zotero notes"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="edit_note"
                        label="Note Edits"
                        description="Changes to Zotero note content"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_highlight_annotations"
                        label="PDF Annotations"
                        description="Creating and editing annotations. Deleting annotations always asks for confirmation."
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_items"
                        label="Item Imports"
                        description="Importing new items from external sources"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_collection"
                        label="Item Organization"
                        description="Creating collections and adding or removing tags and collections on selected items"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="manage_tags"
                        label="Tag & Collection Management"
                        description="Library-wide tag and collection rename, move, merge, and delete operations"
                    />
                </div>
            </SettingsGroup>

            <SectionLabel>Checkpoints</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Pause Long-Running Tasks"
                    description={
                        <>
                            Beaver pauses during long-running tasks to summarize progress and check in. Disabling may use additional credits or increase API costs. <DocLink path="credits">Learn more</DocLink>
                        </>
                    }
                    onClick={handlePauseLongRunningAgentToggle}
                    // tooltip="When enabled, the agent pauses after a set number of steps, reports progress, and asks whether to continue. Disable to let the agent run to completion without interruption."
                    control={
                        <input
                            type="checkbox"
                            checked={pauseLongRunningAgent}
                            onChange={handlePauseLongRunningAgentToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
                <SettingsRow
                    title="Confirm Credit Use"
                    description={
                        <>
                            Ask once per request before it goes over the credit limit below. Only relevant when using Beaver credits. <DocLink path="credits">Learn more</DocLink>
                        </>
                    }
                    onClick={handleConfirmCreditsToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={confirmCredits}
                            onChange={handleConfirmCreditsToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
                {confirmCredits && (
                    <SettingsRow
                        title="Credit Limit"
                        description="Beaver asks before a single request is projected to use more credits than this."
                        hasBorder
                        control={
                            <input
                                type="number"
                                min={0}
                                step={1}
                                inputMode="decimal"
                                aria-label="Credit limit"
                                value={creditThresholdText}
                                onChange={(e) => setCreditThresholdText(e.target.value)}
                                onBlur={commitCreditThreshold}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                }}
                                onClick={(e) => e.stopPropagation()}
                                style={{ width: '72px', margin: 0 }}
                            />
                        }
                    />
                )}
                <SettingsRow
                    title="Approval Notifications"
                    description="Show a system notification when an agent action needs your approval and Beaver is not visible."
                    onClick={handleEnableSystemNotificationsToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={enableSystemNotifications}
                            onChange={handleEnableSystemNotificationsToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
                <SettingsRow
                    title="Response Notifications"
                    description="Show a system notification when a response is ready and Beaver is not visible."
                    onClick={handleEnableResponseCompleteNotificationsToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={enableResponseCompleteNotifications}
                            onChange={handleEnableResponseCompleteNotificationsToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
            </SettingsGroup>

            <SectionLabel>Auto-Apply</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Auto-Apply Annotations"
                    description="Automatically apply annotations to PDFs when created by the agent (only when PDF is open)"
                    onClick={handleAutoApplyAnnotationsToggle}
                    control={
                        <input
                            type="checkbox"
                            checked={autoApplyAnnotations}
                            onChange={handleAutoApplyAnnotationsToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
                <SettingsRow
                    title="Auto-Create Zotero Notes"
                    description="Automatically create Zotero notes when generated by the agent"
                    onClick={handleAutoCreateNotesToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={autoCreateNotes}
                            onChange={handleAutoCreateNotesToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
            </SettingsGroup>

            <SectionLabel>File Access</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Access Remote Files"
                    description="Download PDF files from the Zotero server when not available locally"
                    onClick={handleAccessRemoteFilesToggle}
                    tooltip="When enabled, Beaver will attempt to download PDFs from the Zotero server or WebDAV if the file is not on your local machine. Disable this if you experience slow responses or don't want remote file downloads."
                    control={
                        <input
                            type="checkbox"
                            checked={accessRemoteFiles}
                            onChange={handleAccessRemoteFilesToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default PermissionsSection;
