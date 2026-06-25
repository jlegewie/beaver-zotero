import React, { useCallback, useEffect, useMemo, useState } from "react";
import Button from "../ui/Button";
import {SettingsGroup, SettingsRow, DocLink} from "./components/SettingsElements";
import { dataProviderEnabledAtom, mcpCreateNoteToolEnabledAtom, mcpServerEnabledAtom } from "../../atoms/ui";
import { isMcpServerSupportedAtom } from "../../atoms/profile";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { currentMessageExternalFilesAtom } from "../../atoms/messageComposition";
import { ensureMcpBridgeScript } from "../../hooks/useMcpServer";
import { copyToClipboard } from "../../utils/clipboard";
import { logger } from "../../../src/utils/logger";
import { setPref } from "../../../src/utils/prefs";
import { TickIcon, CopyIcon } from "../icons/icons";
import CustomInstructionsSection from "./CustomInstructionsSection";
import {
    deleteAllExternalFiles,
    getExternalFilesStats,
    revealExternalFilesDir,
} from "../../../src/services/externalFiles";

/** "3 files, 12.4 MB" style summary for the external files row. */
function formatStorageStats(count: number, totalBytes: number): string {
    const files = `${count} file${count === 1 ? '' : 's'}`;
    if (totalBytes <= 0) return files;
    const mb = totalBytes / 1024 / 1024;
    const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(totalBytes / 1024))} KB`;
    return `${files}, ${size}`;
}


const AdvancedSection: React.FC = () => {

    // --- Storage: external files + document cache ---
    const setCurrentMessageExternalFiles = useSetAtom(currentMessageExternalFilesAtom);
    const [externalFileStats, setExternalFileStats] = useState<{ count: number; totalBytes: number } | null>(null);
    const [isDeletingExternalFiles, setIsDeletingExternalFiles] = useState(false);
    const [isDeletingCache, setIsDeletingCache] = useState(false);
    const [cacheDeleted, setCacheDeleted] = useState(false);

    const refreshExternalFileStats = useCallback(async () => {
        try {
            setExternalFileStats(await getExternalFilesStats());
        } catch (error) {
            logger(`AdvancedSection: failed to load external file stats: ${error}`, 1);
            setExternalFileStats(null);
        }
    }, []);

    useEffect(() => {
        refreshExternalFileStats();
    }, [refreshExternalFileStats]);

    const handleShowExternalFilesFolder = useCallback(() => {
        revealExternalFilesDir().catch((error) => {
            logger(`AdvancedSection: failed to reveal external files folder: ${error}`, 1);
        });
    }, []);

    const handleDeleteAllExternalFiles = useCallback(async () => {
        const stats = externalFileStats ?? { count: 0, totalBytes: 0 };
        const buttonIndex = Zotero.Prompt.confirm({
            window: Zotero.getMainWindow(),
            title: 'Delete External Files?',
            text:
                `Delete ${formatStorageStats(stats.count, stats.totalBytes)} attached to past chats?\n\n` +
                'Beaver will no longer be able to read these files in past conversations. ' +
                'Files can be re-attached at any time.',
            button0: 'Delete',
            // Cancel at button1 so Escape/dialog-close routes here.
            button1: Zotero.Prompt.BUTTON_TITLE_CANCEL,
            defaultButton: 1,
        });
        if (buttonIndex !== 0) return;
        setIsDeletingExternalFiles(true);
        try {
            await deleteAllExternalFiles();
            // Pending input-area chips reference the deleted copies.
            setCurrentMessageExternalFiles([]);
        } catch (error) {
            logger(`AdvancedSection: failed to delete external files: ${error}`, 1);
        } finally {
            setIsDeletingExternalFiles(false);
            refreshExternalFileStats();
        }
    }, [externalFileStats, refreshExternalFileStats, setCurrentMessageExternalFiles]);

    const handleDeleteDocumentCache = useCallback(async () => {
        setIsDeletingCache(true);
        try {
            await Zotero.Beaver?.documentCache?.clearAll();
            setCacheDeleted(true);
            setTimeout(() => setCacheDeleted(false), 2000);
        } catch (error) {
            logger(`AdvancedSection: failed to clear document cache: ${error}`, 1);
        } finally {
            setIsDeletingCache(false);
        }
    }, []);

    // --- Atoms: MCP Server enabled ---
    const [mcpServerEnabled, setMcpServerEnabled] = useAtom(mcpServerEnabledAtom);
    const [mcpCreateNoteToolEnabled, setMcpCreateNoteToolEnabled] = useAtom(mcpCreateNoteToolEnabledAtom);
    const [mcpCopied, setMcpCopied] = useState(false);
    const [mcpHttpCopied, setMcpHttpCopied] = useState(false);
    const isMcpServerSupported = useAtomValue(isMcpServerSupportedAtom);

    // --- MCP Server port ---
    const mcpServerPort = useMemo(() => {
        try {
            return Zotero.Prefs.get('httpServer.port') || 23119;
        } catch {
            return 23119;
        }
    }, []);

    // --- Copy MCP config for HTTP clients ---
    const handleCopyMcpConfig = useCallback(async () => {
        try {
            const scriptPath = await ensureMcpBridgeScript();
            const serverConfig: any = {
                command: "node",
                args: [scriptPath],
            };
            if (mcpServerPort !== 23119) {
                serverConfig.args.push(String(mcpServerPort));
            }
            const config = JSON.stringify({
                mcpServers: {
                    "beaver-zotero": serverConfig,
                }
            }, null, 2);
            await copyToClipboard(config);
            setMcpCopied(true);
            setTimeout(() => setMcpCopied(false), 2000);
        } catch (err: any) {
            logger(`Failed to copy MCP config: ${err?.message}`, 1);
        }
    }, [mcpServerPort]);

    const mcpEndpointUrl = `http://localhost:${mcpServerPort}/beaver/mcp`;

    // --- Copy MCP config for HTTPS-only clients ---
    const handleCopyMcpHttpConfig = useCallback(async () => {
        const config = JSON.stringify({
            mcpServers: {
                "beaver-zotero": {
                    type: "http",
                    url: mcpEndpointUrl
                }
            }
        }, null, 2);
        await copyToClipboard(config);
        setMcpHttpCopied(true);
        setTimeout(() => setMcpHttpCopied(false), 2000);
    }, [mcpEndpointUrl]);

    // --- Toggle MCP server enabled ---
    const handleMcpServerToggle = useCallback(() => {
        if (!isMcpServerSupported) return;
        const newValue = !mcpServerEnabled;
        setPref('mcpServerEnabled', newValue);
        setMcpServerEnabled(newValue);
    }, [mcpServerEnabled, isMcpServerSupported, setMcpServerEnabled]);

    const handleMcpCreateNoteToolToggle = useCallback(() => {
        if (!isMcpServerSupported) return;
        const newValue = !mcpCreateNoteToolEnabled;
        setPref('mcpCreateNoteToolEnabled', newValue);
        setMcpCreateNoteToolEnabled(newValue);
    }, [mcpCreateNoteToolEnabled, isMcpServerSupported, setMcpCreateNoteToolEnabled]);

    // --- Data provider (library access for other Beaver clients) ---
    const [dataProviderEnabled, setDataProviderEnabled] = useAtom(dataProviderEnabledAtom);
    const handleDataProviderToggle = useCallback(() => {
        const newValue = !dataProviderEnabled;
        setPref('dataProviderEnabled', newValue);
        setDataProviderEnabled(newValue);
    }, [dataProviderEnabled, setDataProviderEnabled]);

    return (
        <>
            {/* ===== CUSTOM INSTRUCTIONS ===== */}
            <CustomInstructionsSection />

            {/* ===== STORAGE ===== */}
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">Storage</div>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Data Beaver stores on this computer. This data is not deleted automatically including when the plugin is removed.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="External Files"
                    description={
                        <>
                            Copies of external files you attach to chats.
                            {externalFileStats && externalFileStats.count > 0 && (
                                <span className="display-flex mt-1">
                                    {formatStorageStats(externalFileStats.count, externalFileStats.totalBytes)}
                                </span>
                            )}
                        </>
                    }
                    control={
                        <div className="display-flex flex-row items-center gap-2">
                            <Button
                                variant="outline"
                                onClick={handleDeleteAllExternalFiles}
                                disabled={isDeletingExternalFiles || !externalFileStats || externalFileStats.count === 0}
                                loading={isDeletingExternalFiles}
                            >
                                Delete All…
                            </Button>
                            <Button
                                variant="outline"
                                onClick={handleShowExternalFilesFolder}
                            >
                                Show Folder
                            </Button>
                        </div>
                    }
                />
                <SettingsRow
                    title="Document Cache"
                    description="Text extracted from PDFs and other documents, stored to avoid re-processing files"
                    hasBorder
                    control={
                        <Button
                            variant="outline"
                            icon={cacheDeleted ? TickIcon : undefined}
                            onClick={handleDeleteDocumentCache}
                            disabled={isDeletingCache}
                            loading={isDeletingCache}
                        >
                            {cacheDeleted ? 'Deleted' : 'Delete Cache'}
                        </Button>
                    }
                />
            </SettingsGroup>

            {/* ===== CONNECTED APPS (DATA PROVIDER) ===== */}
            {process.env.NODE_ENV === 'development' && (
                <>
                    <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                        <div className="text-lg font-color-primary font-bold">Connected Apps</div>
                        <span className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary">Experimental</span>
                    </div>
                    <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                        Lets Beaver in other apps access your Zotero library while Zotero is running.
                    </div>
                    <SettingsGroup>
                        <SettingsRow
                            title="Allow Library Access"
                            description="Beaver chats started in connected apps can search and read this Zotero library"
                            onClick={handleDataProviderToggle}
                            control={
                                <div className="display-flex flex-row items-center gap-2">
                                    <input
                                        type="checkbox"
                                        aria-label="Allow Library Access"
                                        checked={dataProviderEnabled}
                                        onChange={handleDataProviderToggle}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{ cursor: 'pointer', margin: 0 }}
                                    />
                                </div>
                            }
                        />
                    </SettingsGroup>
                </>
            )}

            {/* ===== MCP SERVER ===== */}
            <div className="display-flex flex-row items-center gap-2" style={{ marginTop: '20px', marginBottom: '6px', paddingLeft: '2px' }}>
                <div className="text-lg font-color-primary font-bold">MCP Server</div>
                <span className="text-xs font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary">Experimental</span>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                The MCP server lets AI coding tools like Claude Code, Cursor, and Windsurf search and access your Zotero library.
                {' '}See our <DocLink path="mcp-server">MCP server guide</DocLink> for setup instructions.
            </div>
            <SettingsGroup>
                <SettingsRow
                    title="Enable MCP Server"
                    description={`Endpoint at localhost:${mcpServerPort}`}
                    onClick={handleMcpServerToggle}
                    disabled={!isMcpServerSupported}
                    tooltip={isMcpServerSupported
                        ? 'Expose your Zotero library to MCP-compatible AI tools'
                        : 'Only available with Beaver Pro'}
                    control={
                        <div className="display-flex flex-row items-center gap-2">
                            <input
                                type="checkbox"
                                aria-label="Enable MCP Server"
                                checked={mcpServerEnabled}
                                onChange={handleMcpServerToggle}
                                onClick={(e) => e.stopPropagation()}
                                disabled={!isMcpServerSupported}
                                style={{ cursor: isMcpServerSupported ? 'pointer' : 'not-allowed', margin: 0 }}
                            />
                        </div>
                    }
                />
                <SettingsRow
                    title="Enable Create Note Tool"
                    description="Allow MCP clients to create Zotero notes. Changing setting requires reloading of the MCP server."
                    onClick={handleMcpCreateNoteToolToggle}
                    hasBorder
                    disabled={!isMcpServerSupported}
                    tooltip={isMcpServerSupported
                        ? 'Advertise and allow the create_note MCP tool'
                        : 'Only available with Beaver Pro'}
                    control={
                        <div className="display-flex flex-row items-center gap-2">
                            <input
                                type="checkbox"
                                aria-label="Enable Create Note Tool"
                                checked={mcpCreateNoteToolEnabled}
                                onChange={handleMcpCreateNoteToolToggle}
                                onClick={(e) => e.stopPropagation()}
                                disabled={!isMcpServerSupported}
                                style={{ cursor: isMcpServerSupported ? 'pointer' : 'not-allowed', margin: 0 }}
                            />
                        </div>
                    }
                />
                <SettingsRow
                    title="Config for HTTP Clients"
                    description={
                        <span className="display-flex flex-col gap-05" style={{ opacity: mcpServerEnabled ? 1 : 0.45 }}>
                            <span>For clients that support HTTP directly (e.g., Claude Code, Cursor).</span>
                            {/* <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{mcpEndpointUrl}</span> */}
                        </span>
                    }
                    hasBorder
                    disabled={!mcpServerEnabled}
                    control={
                        <Button
                            variant="outline"
                            icon={mcpHttpCopied ? TickIcon : CopyIcon}
                            onClick={handleCopyMcpHttpConfig}
                            disabled={!mcpServerEnabled}
                        >
                            {mcpHttpCopied ? 'Copied' : 'Copy'}
                        </Button>
                    }
                />
                <SettingsRow
                    title="Config for HTTPS-Only Clients"
                    description={
                        <span style={{ opacity: mcpServerEnabled ? 1 : 0.45 }}>
                            For clients that only connect to HTTPS endpoints (e.g., Claude Desktop). Requires Node.js.
                        </span>
                    }
                    hasBorder
                    disabled={!mcpServerEnabled}
                    control={
                        <Button
                            variant="outline"
                            icon={mcpCopied ? TickIcon : CopyIcon}
                            onClick={handleCopyMcpConfig}
                            disabled={!mcpServerEnabled}
                        >
                            {mcpCopied ? 'Copied' : 'Copy'}
                        </Button>
                    }
                />
            </SettingsGroup>
        </>
    );
};

export default AdvancedSection;
