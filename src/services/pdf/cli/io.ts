/**
 * Filesystem and hash helpers for the CLI.
 *
 * Kept tiny and dep-free so the unit-test seam (`runCli(argv, deps)`)
 * can swap them with in-memory implementations without dragging
 * `node:fs` into the test graph.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadPdf(path: string): Promise<Uint8Array> {
    const buf = await readFile(path);
    return new Uint8Array(buf);
}

export function pdfSha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export async function writePngFile(
    path: string,
    bytes: Uint8Array,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
}

export async function writeJsonFile(
    path: string,
    value: unknown,
    pretty = false,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const json = pretty
        ? JSON.stringify(value, null, 2)
        : JSON.stringify(value);
    await writeFile(path, json + "\n", "utf8");
}
