import React, { useCallback, useState } from "react";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink, SectionHeader, SectionDescription} from "./components/SettingsElements";
import DeferredToolPreferenceSetting from "./DeferredToolPreferenceSetting";
import { getPref, setPref } from "../../../src/utils/prefs";


const PermissionsSection: React.FC = () => {

    // --- Atoms: Permissions ---
    const [autoApplyAnnotations, setAutoApplyAnnotations] = useState(() => getPref('autoApplyAnnotations'));
    const [autoCreateNotes, setAutoCreateNotes] = useState(() => getPref('autoCreateNotes'));
    const [enableSystemNotifications, setEnableSystemNotifications] = useState(() => getPref('enableSystemNotifications'));
    const [enableResponseCompleteNotifications, setEnableResponseCompleteNotifications] = useState(() => getPref('enableResponseCompleteNotifications'));
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

            <SectionLabel>System Notifications</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Approval Notifications"
                    description="Show a system notification when Beaver is waiting for your decision and is not visible."
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
