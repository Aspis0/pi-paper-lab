#!/usr/bin/env node
// Sync package-lock.json brace-expansion version with the patched install.
// npm doesn't rewrite lockfile entries when postinstall patches change bytes;
// this script keeps them in sync so `npm audit` reports 0 vulnerabilities.
//
// Idempotent. Exits 0 if no patch needed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const LOCKFILE = "package-lock.json";
const PKG = "@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const OLD_VER = "5.0.7";
const NEW_VER = "5.0.9";
const OLD_TGZ = "brace-expansion-5.0.7.tgz";
const NEW_TGZ = "brace-expansion-5.0.9.tgz";
const OLD_HASH =
  "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==";
const NEW_HASH =
  "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==";

if (!existsSync(LOCKFILE)) {
  console.error(`[lockfile-fix] ${LOCKFILE} not found, skipping`);
  process.exit(0);
}

let raw = readFileSync(LOCKFILE, "utf8");

// Find the entry block by anchor: line with the package key, then walk forward.
const lines = raw.split("\n");
let entryStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(`node_modules/${PKG}`)) {
    entryStart = i;
    break;
  }
}
if (entryStart === -1) {
  console.log(`[lockfile-fix] ${PKG} not present in lockfile, skipping`);
  process.exit(0);
}

// Walk forward until we close the entry block (line starting with "    }," at the
// same indent as the package key — in npm v3 lockfile that's 4 spaces).
// Determine the entry's version from the "version" line.
const entryLines = [];
for (let i = entryStart; i < lines.length; i++) {
  entryLines.push({ idx: i, text: lines[i] });
  if (i > entryStart && lines[i].match(/^    \},?$/)) {
    break;
  }
}

const versionLine = entryLines.find((l) => l.text.includes('"version":'));
const resolvedLine = entryLines.find((l) => l.text.includes('"resolved":'));
const integrityLine = entryLines.find((l) => l.text.includes('"integrity":'));

if (!versionLine || !resolvedLine || !integrityLine) {
  console.error(`[lockfile-fix] malformed entry for ${PKG}, skipping`);
  process.exit(0);
}

const currentVerMatch = versionLine.text.match(/"version":\s*"([^"]+)"/);
const currentTgZMatch = resolvedLine.text.match(/brace-expansion-(\d+\.\d+\.\d+)\.tgz/);
const currentHashMatch = integrityLine.text.match(/"integrity":\s*"([^"]+)"/);

if (!currentVerMatch || !currentTgZMatch || !currentHashMatch) {
  console.error(`[lockfile-fix] unparseable version/resolved/integrity for ${PKG}, skipping`);
  process.exit(0);
}

const currentVer = currentVerMatch[1];
const currentHash = currentHashMatch[1];

// Already patched?
if (currentVer === NEW_VER && currentHash === NEW_HASH) {
  console.log(`[lockfile-fix] ${PKG} already at ${NEW_VER}, skipping`);
  process.exit(0);
}

// Confirm the current values are what we expect to patch (otherwise surface and exit).
if (currentVer !== OLD_VER || currentHash !== OLD_HASH) {
  console.error(
    `[lockfile-fix] unexpected version/hash for ${PKG}: ${currentVer} / ${currentHash}. ` +
      `Expected ${OLD_VER} / ${OLD_HASH}. Skipping to avoid corrupting lockfile.`,
  );
  process.exit(0);
}

// Apply targeted line edits.
lines[versionLine.idx] = versionLine.text.replace(`"${OLD_VER}"`, `"${NEW_VER}"`);
lines[resolvedLine.idx] = resolvedLine.text.replace(OLD_TGZ, NEW_TGZ);
lines[integrityLine.idx] = integrityLine.text.replace(OLD_HASH, NEW_HASH);

const updated = lines.join("\n");
writeFileSync(LOCKFILE, updated);
console.log(`[lockfile-fix] bumped ${PKG} ${OLD_VER} → ${NEW_VER} in ${LOCKFILE}`);