import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRun, TextPart, ToolCallPart } from '../../agents/types';
import { RepeatIcon, ShareIcon, ArrowDownIcon, ArrowRightIcon } from '../icons/icons';
import { copyToClipboard } from '../../utils/clipboard';
import IconButton from '../ui/IconButton';
import MenuButton from '../ui/MenuButton';
import Button from '../ui/Button';
import CitedSourcesList from '../sources/CitedSourcesList';
import { renderToMarkdown, renderToHTML, preprocessNoteContent } from '../../utils/citationRenderers';
import CopyButton from '../ui/buttons/CopyButton';
import { citationDataMapAtom, citationsByRunIdAtom, citationKeyToMarkerAtom } from '../../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { selectItem } from '../../../src/utils/selectItem';
import { CitationData, getCitationKey } from '../../types/citations';
import { messageSourcesVisibilityAtom, toggleMessageSourcesVisibilityAtom, setMessageSourcesVisibilityAtom } from '../../atoms/messageUIState';
import { getZoteroTargetContextSync } from '../../../src/utils/zoteroUtils';
import { toolResultsMapAtom } from '../../agents/atoms';
import { getToolCallLabel } from '../../agents/toolLabels';
import TokenUsageDisplay from './TokenUsageDisplay';
import { regenerateFromRunAtom } from '../../atoms/agentRunAtoms';
import { currentThreadIdAtom } from '../../atoms/threads';
import { store } from '../../store';
import Tooltip from '../ui/Tooltip';

interface AgentRunFooterProps {
    run: AgentRun;
}

/**
 * Footer component for agent runs.
 * Displays sources, share options, regenerate, and copy buttons.
 */
export const AgentRunFooter: React.FC<AgentRunFooterProps> = ({ run }) => {
    const citationDataMap = useAtomValue(citationDataMapAtom);
    const citationsByRunId = useAtomValue(citationsByRunIdAtom);
    const runCitations = citationsByRunId[run.id] || [];
    const externalReferenceMapping = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferencesMap = useAtomValue(externalReferenceMappingAtom);
    const toolResultsMap = useAtomValue(toolResultsMapAtom);
    const citationMarkerMap = useAtomValue(citationKeyToMarkerAtom);
    
    // Force re-render when menu opens to get fresh context for disabled state
    const [, forceUpdate] = useState({});
    
    const handleMenuToggle = useCallback((isOpen: boolean) => {
        if (isOpen) forceUpdate({});
    }, []);

    // Get unique citations for this run, enriched with CitationData
    const uniqueCitations = useMemo(() => {
        const seen = new Set<string>();
        const unique: CitationData[] = [];
        
        for (const citation of runCitations) {
            if (citation.invalid) continue;
            const key = getCitationKey(citation);
            if (!seen.has(key)) {
                seen.add(key);
                // Look up the correct marker from the thread-scoped atom
                const numericCitation = citationMarkerMap[key] || null;
                // Look up enriched data from citationDataMapAtom
                const enrichedData = citationDataMap[citation.citation_id];
                if (enrichedData) {
                    unique.push({
                        ...enrichedData,
                        numericCitation
                    });
                } else {
                    // Fallback: create minimal CitationData from CitationMetadata
                    unique.push({
                        ...citation,
                        type: citation.citation_type === 'external_reference' ? 'external' : 
                              citation.citation_type === 'attachment' ? 'attachment' : 'item',
                        parentKey: null,
                        icon: null,
                        name: citation.author_year || null,
                        citation: citation.author_year || null,
                        formatted_citation: null,
                        url: null,
                        numericCitation,
                        message_id: run.id, // Use run ID as message ID for compatibility
                    } as CitationData);
                }
            }
        }
        
        return unique;
    }, [runCitations, citationDataMap, citationMarkerMap]);

    // Sources visibility state
    const sourcesVisibilityMap = useAtomValue(messageSourcesVisibilityAtom);
    const sourcesVisible = sourcesVisibilityMap[run.id] ?? false;
    const toggleSourcesVisibility = useSetAtom(toggleMessageSourcesVisibilityAtom);
    const setSourcesVisibility = useSetAtom(setMessageSourcesVisibilityAtom);

    // Toggle sources visibility
    const toggleSources = () => {
        toggleSourcesVisibility(run.id);
    };

    // Auto-hide sources if no citations
    useEffect(() => {
        if (uniqueCitations.length === 0 && sourcesVisible) {
            setSourcesVisibility({ messageId: run.id, visible: false });
        }
    }, [run.id, setSourcesVisibility, sourcesVisible, uniqueCitations.length]);

    // Extract tool call details for copy/export
    const getToolDetails = (part: ToolCallPart): string => {
        const label = getToolCallLabel(part, 'completed');
        let query = "";
        try {
            const args = typeof part.args === 'object' && part.args
                ? part.args
                : typeof part.args === 'string' && part.args.startsWith('{')
                    ? JSON.parse(part.args)
                    : {};
            query = args.search_label || args.query || args.q || args.keywords || args.topic || args.search_term || "";
        } catch (e) {
            console.error('Error parsing tool call arguments:', e);
        }
        
        const result = toolResultsMap.get(part.tool_call_id);
        const count = result && result.part_kind === 'tool-return'
            ? result?.metadata?.summary?.result_count ?? null
            : null;
        
        let details = `[${label}`;
        if (query) details += `: "${query}"`;
        if (result && count !== null) details += ` (${count} results)`;
        details += `]`;
        return details;
    };

    // Combine all text content from the run's model messages
    const combinedContent = useMemo(() => {
        const parts: string[] = [];
        
        for (const message of run.model_messages) {
            if (message.kind === 'response') {
                // Extract text parts
                const textContent = message.parts
                    .filter((part): part is TextPart => part.part_kind === 'text')
                    .map(part => part.content)
                    .filter(Boolean)
                    .join('\n\n');
                
                if (textContent) {
                    parts.push(textContent);
                }
                
                // Extract tool call descriptions
                const toolCallParts = message.parts.filter(
                    (part): part is ToolCallPart => part.part_kind === 'tool-call'
                );
                if (toolCallParts.length > 0) {
                    const toolDescriptions = toolCallParts.map(getToolDetails).join('\n\n');
                    parts.push(toolDescriptions);
                }
            }
        }
        
        return parts.filter(Boolean).join('\n\n');
    }, [run.model_messages, toolResultsMap]);

    // Build share menu items
    const getShareMenuItems = () => {
        const context = getZoteroTargetContextSync();
        const hasParent = context.parentReference !== null;

        const items = [
            {
                label: 'Copy',
                onClick: () => handleCopy()
            },
            {
                label: 'Save as Note',
                onClick: () => saveToLibrary()
            },
            {
                label: 'Save as Child Note',
                onClick: () => saveToItem(),
                disabled: !hasParent
            },
            {
                label: 'Copy Run ID',
                onClick: () => copyRunId()
            }
        ];

        if (Zotero.Beaver.data.env === "development") {
            items.push({
                label: 'Copy Thread ID',
                onClick: () => copyThreadId()
            });
            items.push({
                label: 'Copy Citation Metadata',
                onClick: () => copyCitationMetadata()
            });
        }

        return items;
    };

    const handleCopy = async () => {
        const formattedContent = renderToMarkdown(combinedContent);
        await copyToClipboard(formattedContent);
    };

    /** Save as standalone note to current library/collection */
    const saveToLibrary = async () => {
        const formattedContent = renderToHTML(preprocessNoteContent(combinedContent), "markdown", { 
            citationDataMap, 
            externalMapping: externalReferenceMapping,
            externalReferencesMap 
        });
        const context = getZoteroTargetContextSync();
        
        const newNote = new Zotero.Item('note');
        if (context.targetLibraryId !== undefined) {
            newNote.libraryID = context.targetLibraryId;
        }
        newNote.setNote(formattedContent);
        await newNote.saveTx();
        
        // Add to collection if one is selected
        if (context.collectionToAddTo) {
            await context.collectionToAddTo.addItem(newNote.id);
        }
        
        // Only navigate to the item in library view, not in reader
        const win = Zotero.getMainWindow();
        const isInReader = win.Zotero_Tabs?.selectedType === 'reader';
        if (!isInReader) {
            selectItem(newNote);
        }
    };

    /** Save as child note attached to selected/current item */
    const saveToItem = async () => {
        const formattedContent = renderToHTML(preprocessNoteContent(combinedContent), "markdown", { 
            citationDataMap, 
            externalMapping: externalReferenceMapping,
            externalReferencesMap 
        });
        const context = getZoteroTargetContextSync();
        
        if (!context.parentReference) return;
        
        const newNote = new Zotero.Item('note');
        newNote.libraryID = context.parentReference.library_id;
        newNote.parentKey = context.parentReference.zotero_key;
        newNote.setNote(formattedContent);
        await newNote.saveTx();
        
        // Only navigate to the item in library view, not in reader
        const win = Zotero.getMainWindow();
        const isInReader = win.Zotero_Tabs?.selectedType === 'reader';
        if (!isInReader) {
            selectItem(newNote);
        }
    };

    const copyRunId = async () => {
        await copyToClipboard(run.id);
    };

    const copyCitationMetadata = async () => {
        await copyToClipboard(JSON.stringify(runCitations, null, 2));
    };

    const copyThreadId = async () => {
        await copyToClipboard(store.get(currentThreadIdAtom ) || '');
    };

    const regenerateFromRun = useSetAtom(regenerateFromRunAtom);

    const handleRegenerate = async () => {
        const runId = run.user_prompt.is_resume && run.user_prompt.resumes_run_id
            ? run.user_prompt.resumes_run_id
            : run.id;
        await regenerateFromRun(runId);
    };

    // Hide during streaming
    const isStreaming = run.status === 'in_progress';

    return (
        <div className="px-4">
            <div
                className={`
                    display-flex flex-row items-center pt-2 mr-2
                    ${isStreaming ? 'hidden' : ''}
                `}
            >
                {/* Sources button */}
                <div className="flex-1">
                    {uniqueCitations.length > 0 && (
                        <Button
                            variant="ghost"
                            onClick={toggleSources}
                            icon={sourcesVisible ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="mr-0 scale-12 -ml-1"
                        >
                            <span>
                                {uniqueCitations.length} Source{uniqueCitations.length === 1 ? '' : 's'}
                            </span>
                        </Button>
                    )}
                </div>
                
                {/* Action buttons */}
                <div className="display-flex gap-4">
                    {/* Usage display */}
                    {Zotero.Beaver.data.env === "development" && run.status === 'completed' && run.total_usage && run.total_cost && (
                        <TokenUsageDisplay usage={run.total_usage} cost={run.total_cost} />
                    )}
                    {/* Share button */}
                    <Tooltip
                        content="More options"
                        showArrow
                        singleLine
                    >
                        <MenuButton
                            icon={ShareIcon}
                            menuItems={getShareMenuItems()}
                            className="scale-11"
                            ariaLabel="Share"
                            variant="ghost"
                            positionAdjustment={{ x: 0, y: 0 }}
                            toggleCallback={handleMenuToggle}
                        />
                    </Tooltip>
                    <Tooltip
                        content="Retry"
                        showArrow
                    >
                        <IconButton
                            icon={RepeatIcon}
                            onClick={handleRegenerate}
                            className="scale-11"
                            ariaLabel="Retry"
                        />
                    </Tooltip>
                    <Tooltip
                        content="Copy"
                        showArrow
                    >
                        <CopyButton
                            content={combinedContent}
                            formatContent={renderToMarkdown}
                            className="scale-11"
                        />
                    </Tooltip>
                </div>
            </div>

            {/* Sources section */}
            {sourcesVisible && (
                <CitedSourcesList citations={uniqueCitations} />
            )}
        </div>
    );
};

export default AgentRunFooter;

