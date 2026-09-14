import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RiskFlag } from "@wma/core";

const SCAN_CACHE_VERSION = 2;

export interface ScanCacheEntry {
  bytes: number;
  mtimeMs: number;
  estimatedTokens: number;
  riskFlags: RiskFlag[];
}

interface ScanCacheFile {
  version: typeof SCAN_CACHE_VERSION;
  tokenizerKey: string;
  files: Record<string, ScanCacheEntry>;
}

export async function loadScanCache(cacheFile: string | undefined, tokenizerKey: string): Promise<Map<string, ScanCacheEntry>> {
  if (!cacheFile) return new Map();
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8")) as ScanCacheFile;
    if (parsed.version !== SCAN_CACHE_VERSION || parsed.tokenizerKey !== tokenizerKey || !parsed.files) return new Map();
    return new Map(Object.entries(parsed.files));
  } catch {
    return new Map();
  }
}

export async function saveScanCache(cacheFile: string | undefined, tokenizerKey: string, files: Map<string, ScanCacheEntry>): Promise<void> {
  if (!cacheFile) return;
  await mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  const payload: ScanCacheFile = { version: SCAN_CACHE_VERSION, tokenizerKey, files: Object.fromEntries(files) };
  await writeFile(temporary, JSON.stringify(payload), "utf8");
  await rename(temporary, cacheFile).catch(async () => {
    await writeFile(cacheFile, JSON.stringify(payload), "utf8");
    await rm(temporary, { force: true });
  });
}
