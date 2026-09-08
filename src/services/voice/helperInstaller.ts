import contract from "../../../native/voice/macos/contract.json";
import { runVoiceProcess as run } from "./voiceProcess";

/** Build identity and asserted protocol compatibility; platform policy lives in contract.json. */
export interface HelperManifest extends Pick<
    typeof contract,
    "schema" | "protocolVersion" | "helperVersion" | "bundleId"
> {
    version: string;
    signing: "development" | "developer-id";
    teamId: string | null;
    archiveSha256: string;
    archiveBytes: number;
    executableSha256: string;
    plistSha256: string;
}

export function validateHelperManifest(
    value: unknown,
    development: boolean,
): HelperManifest {
    const m = value as HelperManifest;
    const digest = (s: unknown) =>
        typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
    if (
        !m ||
        m.schema !== contract.schema ||
        m.protocolVersion !== contract.protocolVersion ||
        m.helperVersion !== contract.helperVersion ||
        m.bundleId !== contract.bundleId ||
        typeof m.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(m.version) ||
        !Number.isInteger(m.archiveBytes) ||
        m.archiveBytes < 1 ||
        m.archiveBytes > 32 * 1024 * 1024 ||
        !digest(m.archiveSha256) ||
        !digest(m.executableSha256) ||
        !digest(m.plistSha256) ||
        !(
            (m.signing === "developer-id" &&
                /^[A-Z0-9]{10}$/.test(m.teamId ?? "")) ||
            (development && m.signing === "development" && m.teamId === null)
        )
    ) {
        throw new Error("Incompatible or untrusted voice helper manifest");
    }
    return m;
}

export interface HelperInstallerHost {
    manifest(): Promise<unknown>;
    checkPlatform(): Promise<void>;
    exists(path: string): Promise<boolean>;
    stage(path: string, manifest: HelperManifest): Promise<void>;
    verify(path: string, manifest: HelperManifest): Promise<void>;
    move(from: string, to: string): Promise<void>;
    remove(path: string): Promise<void>;
    touch(path: string): Promise<void>;
    cleanup(current: string): Promise<void>;
    unique(): string;
}

/** Publishes only verified, immutable versions. Failed installs leave previous versions intact. */
export class HelperInstaller {
    private pending?: Promise<string>;
    private disposed = false;
    constructor(
        private readonly host: HelperInstallerHost,
        private readonly root: string,
        private readonly development: boolean,
    ) {}

    ensure(): Promise<string> {
        if (this.disposed)
            return Promise.reject(new Error("Voice installer disposed"));
        if (this.pending) return this.pending;
        this.pending = this.install().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }
    dispose() {
        this.disposed = true;
    }
    private check() {
        if (this.disposed) throw new Error("Voice installer disposed");
    }
    private async install(): Promise<string> {
        const m = validateHelperManifest(
            await this.host.manifest(),
            this.development,
        );
        await this.host.checkPlatform();
        this.check();
        const destination = `${this.root}/${m.archiveSha256}`;
        const exists = await this.host.exists(destination);
        let valid = false;
        if (exists) {
            try {
                await this.host.verify(destination, m);
                valid = true;
            } catch {
                this.check();
            }
        }
        if (!valid) {
            const staging = `${this.root}/staging-${this.host.unique()}`;
            try {
                await this.host.stage(staging, m);
                this.check();
                await this.host.verify(staging, m);
                this.check();
                // Keep the damaged install until its replacement has passed every check.
                if (exists) await this.host.remove(destination);
                await this.host.move(staging, destination);
            } finally {
                await this.host.remove(staging);
            }
        }
        this.check();
        await this.host.touch(destination);
        // Cleanup failure must not prevent use of an otherwise valid installation.
        await this.host.cleanup(destination).catch(() => {});
        this.check();
        return `${destination}/Beaver Voice Input.app`;
    }
}

export function createPackagedHelperInstaller(): HelperInstaller {
    const root = PathUtils.join(Zotero.Profile.dir, "beaver", "voice");
    const asset = "chrome://beaver/content/voice/";
    let platform: Promise<void> | undefined;
    const assessed = new Set<string>();
    const host: HelperInstallerHost = {
        async manifest() {
            const response = await fetch(`${asset}manifest.json`);
            if (!response.ok) throw new Error("Packaged voice helper missing");
            return response.json();
        },
        checkPlatform() {
            // OS/CPU and Zotero version are constant for this plugin lifetime.
            return (platform ??= (async () => {
                const [os, arch] = await Promise.all([
                    run("/usr/bin/sw_vers", ["-productVersion"]),
                    run("/usr/bin/uname", ["-m"]),
                ]);
                if (
                    !Zotero.isMac ||
                    Number(os.split(".")[0]) < contract.minMacOS ||
                    !contract.architectures.includes(arch) ||
                    !contract.zoteroMajors.includes(parseInt(Zotero.version))
                )
                    throw new Error(
                        "Voice capture is unsupported on this system",
                    );
            })().catch((error) => {
                platform = undefined;
                throw error;
            }));
        },
        exists: (path) => IOUtils.exists(path),
        async stage(path, m) {
            await IOUtils.makeDirectory(path, {
                permissions: 0o700,
                createAncestors: true,
            });
            const archive = `${path}/helper.zip`;
            const response = await fetch(`${asset}macos.zip`);
            if (!response.ok) throw new Error("Packaged voice helper missing");
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length !== m.archiveBytes)
                throw new Error("Invalid voice archive size");
            await IOUtils.write(archive, bytes, { mode: "create" });
            if (
                (await IOUtils.computeHexDigest(archive, "sha256")) !==
                m.archiveSha256
            )
                throw new Error("Invalid voice archive digest");
            // Only the authenticated archive is passed to ditto, retaining bundle modes and links.
            await run("/usr/bin/ditto", ["-x", "-k", archive, path]);
            await IOUtils.remove(archive);
        },
        async verify(path, m) {
            const app = `${path}/Beaver Voice Input.app`;
            const executable = `${app}/Contents/MacOS/BeaverVoice`;
            if (
                (await IOUtils.computeHexDigest(executable, "sha256")) !==
                    m.executableSha256 ||
                (await IOUtils.computeHexDigest(
                    `${app}/Contents/Info.plist`,
                    "sha256",
                )) !== m.plistSha256
            )
                throw new Error("Invalid installed voice helper digest");
            const requirement =
                contract.identityRequirement +
                (m.signing === "developer-id"
                    ? contract.developerIdRequirement.replace(
                          "{teamId}",
                          m.teamId!,
                      )
                    : "");
            await run("/usr/bin/codesign", [
                "--verify",
                "--strict",
                "--all-architectures",
                "-R",
                requirement,
                app,
            ]);
            // Digests and the complete code signature are checked on every use.
            // Cache policy/metadata only for this exact artifact in this plugin session.
            const key = JSON.stringify([path, m]);
            if (assessed.has(key)) return;
            if (m.signing === "developer-id")
                await run("/usr/sbin/spctl", [
                    "--assess",
                    "--type",
                    "execute",
                    app,
                ]);
            const info = JSON.parse(await run(executable, ["--voice-info"]));
            if (
                info.protocolVersion !== m.protocolVersion ||
                info.helperVersion !== m.helperVersion ||
                info.testing !== false
            )
                throw new Error("Incompatible voice helper protocol");
            assessed.add(key);
        },
        move: (from, to) => IOUtils.move(from, to, { noOverwrite: true }),
        remove: (path) =>
            IOUtils.remove(path, { recursive: true, ignoreAbsent: true }),
        touch: (path) =>
            IOUtils.writeUTF8(`${path}/last-used`, String(Date.now())).then(
                () => {},
            ),
        async cleanup(current) {
            for (const path of await IOUtils.getChildren(root)) {
                if (
                    path === current ||
                    !/\/(?:[a-f0-9]{64}|staging-[A-Za-z0-9-]+)$/.test(path)
                )
                    continue;
                const marker = `${path}/last-used`;
                const age = (await IOUtils.exists(marker))
                    ? Number(await IOUtils.readUTF8(marker))
                    : (await IOUtils.stat(path)).lastModified;
                // Keep recent versions for rollback and beyond every possible native lease lifetime.
                if (
                    typeof age === "number" &&
                    Number.isFinite(age) &&
                    Date.now() - age > 7 * 86400000
                )
                    await IOUtils.remove(path, { recursive: true });
            }
        },
        unique: () => Zotero.Utilities.randomString(32),
    };
    return new HelperInstaller(host, root, __env__ === "development");
}
