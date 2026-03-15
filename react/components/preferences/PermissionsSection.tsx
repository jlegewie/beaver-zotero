import React, { useCallback, useState } from "react";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink} from "./components/SettingsElements";
import DeferredToolPreferenceSetting from "./DeferredToolPreferenceSetting";
import { getPref, setPref } from "../../../src/utils/prefs";


const PermissionsSection: React.FC = () => {

    // --- Atoms: Permissions ---
    const [autoApplyAnnotations, setAutoApplyAnnotations] = useState(() => getPref('autoApplyAnnotations'));
    const [autoCreateNotes, setAutoCreateNotes] = useState(() => getPref('autoCreateNotes'));
    const [confirmExtractionCosts, setConfirmExtractionCosts] = useState(() => getPref('confirmExtractionCosts'));
    const [confirmExternalSearchCosts, setConfirmExternalSearchCosts] = useState(() => getPref('confirmExternalSearchCosts'));
    const [pauseLongRunningAgent, setPauseLongRunningAgent] = useState(() => getPref('pauseLongRunningAgent'));

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

    // --- Handle Confirm Extraction Costs Toggle ---
    const handleConfirmExtractionCostsToggle = useCallback(() => {
        const newValue = !confirmExtractionCosts;
        setPref('confirmExtractionCosts', newValue);
        setConfirmExtractionCosts(newValue);
    }, [confirmExtractionCosts]);

    // --- Handle Confirm External Search Costs Toggle ---
    const handleConfirmExternalSearchCostsToggle = useCallback(() => {
        const newValue = !confirmExternalSearchCosts;
        setPref('confirmExternalSearchCosts', newValue);
        setConfirmExternalSearchCosts(newValue);
    }, [confirmExternalSearchCosts]);

    // --- Handle Pause Long-Running Agent Toggle ---
    const handlePauseLongRunningAgentToggle = useCallback(() => {
        const newValue = !pauseLongRunningAgent;
        setPref('pauseLongRunningAgent', newValue);
        setPauseLongRunningAgent(newValue);
    }, [pauseLongRunningAgent]);

    return (
        <>
            <SectionLabel>Library Modifications</SectionLabel>
            <SettingsGroup>
                <div className="display-flex flex-col gap-05 flex-1 min-w-0" style={{ padding: '8px 12px' }}>
                    {/* <div className="font-color-primary text-base font-medium">Permissions</div> */}
                    <div className="font-color-secondary text-base">
                        When Beaver modifies your library, all changes require your approval by default.
                        You can change this behavior here. Be careful, Beaver might make changes you didn't expect.
                    
                        For more details, see documentation on <DocLink path="editing-metadata">editing metadata</DocLink> and <DocLink path="library-management">organizing your library items</DocLink>.

                    </div>
                </div>
            </SettingsGroup>
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
                        toolName="create_items"
                        label="Item Imports"
                        description="Importing new items from external sources"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <DeferredToolPreferenceSetting
                        toolName="create_collection"
                        label="Library Organization"
                        description="Creating collections and organizing items into collections and by tags"
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
                    title="Confirm Extraction Costs"
                    description="Ask before using extra credits for batch extraction. Only relevant when using Beaver credits."
                    onClick={handleConfirmExtractionCostsToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={confirmExtractionCosts}
                            onChange={handleConfirmExtractionCostsToggle}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: 'pointer', margin: 0 }}
                        />
                    }
                />
                <SettingsRow
                    title="Confirm External Search Costs"
                    description="Ask before using extra credits for external literature search. Only relevant when using Beaver credits."
                    onClick={handleConfirmExternalSearchCostsToggle}
                    hasBorder
                    control={
                        <input
                            type="checkbox"
                            checked={confirmExternalSearchCosts}
                            onChange={handleConfirmExternalSearchCostsToggle}
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
        </>
    );
};

export default PermissionsSection;
