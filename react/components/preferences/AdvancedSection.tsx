import React, { useCallback, useMemo, useState } from "react";
import Button from "../ui/Button";
import {SettingsGroup, SettingsRow, DocLink} from "./components/SettingsElements";
import { dataProviderEnabledAtom, mcpCreateNoteToolEnabledAtom, mcpServerEnabledAtom } from "../../atoms/ui";
import { isMcpServerSupportedAtom } from "../../atoms/profile";
import { useAtom, useAtomValue } from "jotai";
import { ensureMcpBridgeScript } from "../../hooks/useMcpServer";
import { copyToClipboard } from "../../utils/clipboard";
import { logger } from "../../../src/utils/logger";
import { setPref } from "../../../src/utils/prefs";
import { TickIcon, CopyIcon } from "../icons/icons";
import CustomInstructionsSection from "./CustomInstructionsSection";


const AdvancedSection: React.FC = () => {

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
