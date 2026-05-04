import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const distDir = join(repoRoot, ".scaffold", "build");
const addonDir = join(distDir, "addon");
const xpiName = process.env.XPI_NAME || pkg.config?.addonRef || pkg.name;
const xpiPath = join(distDir, `${xpiName}.xpi`);

const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
    const year = Math.max(date.getFullYear(), 1980);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);

    return {
        date: ((year - 1980) << 9) | (month << 5) | day,
        time: (hours << 11) | (minutes << 5) | seconds,
    };
}

function localFileHeader(entry) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.time, 10);
    header.writeUInt16LE(entry.date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressedSize, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, entry.name]);
}

function centralDirectoryHeader(entry) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    return Buffer.concat([header, entry.name]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
    const header = Buffer.alloc(22);
    header.writeUInt32LE(0x06054b50, 0);
    header.writeUInt16LE(0, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(entryCount, 8);
    header.writeUInt16LE(entryCount, 10);
    header.writeUInt32LE(centralSize, 12);
    header.writeUInt32LE(centralOffset, 16);
    header.writeUInt16LE(0, 20);
    return header;
}

async function collectFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(path));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }

    return files.sort();
}

async function pack() {
    const addonStats = await stat(addonDir).catch(() => null);
    if (!addonStats?.isDirectory()) {
        throw new Error(`Cannot find scaffold addon directory: ${addonDir}`);
    }

    const files = await collectFiles(addonDir);
    if (files.length === 0) {
        throw new Error(`No files found in scaffold addon directory: ${addonDir}`);
    }

    const localParts = [];
    const entries = [];
    let offset = 0;

    for (const file of files) {
        const data = await readFile(file);
        const compressed = deflateRawSync(data, { level: 9 });
        const stats = await stat(file);
        const { date, time } = dosDateTime(stats.mtime);
        const name = Buffer.from(relative(addonDir, file).split(sep).join("/"));
        const entry = {
            name,
            date,
            time,
            method: 8,
            crc: crc32(data),
            compressedSize: compressed.length,
            size: data.length,
            offset,
        };
        const header = localFileHeader(entry);
        localParts.push(header, compressed);
        offset += header.length + compressed.length;
        entries.push(entry);
    }

    const centralOffset = offset;
    const centralParts = entries.map(centralDirectoryHeader);
    const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
    const end = endOfCentralDirectory(entries.length, centralSize, centralOffset);

    await writeFile(xpiPath, Buffer.concat([...localParts, ...centralParts, end]));
    console.log(`Packed ${entries.length} files into ${relative(repoRoot, xpiPath)}`);
}

await pack();
