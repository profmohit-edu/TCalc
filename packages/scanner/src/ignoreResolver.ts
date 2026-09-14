import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { DEFAULT_FILE_SIZE_CONFIG } from "@wma/core";

export interface IgnoreResult {
  ignored: boolean;
  reason?: string;
}

export interface IgnoreResolverOptions {
  additionalIgnoreFiles?: string[];
  userExcludePatterns?: string[];
  maxFileSizeBytes?: number;
  onWarning?: (warning: string) => void;
  signal?: AbortSignal;
}

const IGNORE_FILE_NAMES = [
  ".gitignore",
  ".cursorignore",
  ".aiderignore",
  ".continueignore",
  ".tcalcignore",
];

interface NestedIgnoreFile {
  path: string;
  content: string;
}

export class IgnoreResolver {
  private ig = ignore();

  constructor(private options: IgnoreResolverOptions = {}) {}

  async loadIgnoreFiles(rootPath: string): Promise<void> {
    const files = [...IGNORE_FILE_NAMES, ...(this.options.additionalIgnoreFiles ?? [])];
    for (const fileName of files) {
      this.options.signal?.throwIfAborted();
      try {
        const content = await readFile(path.join(rootPath, fileName), "utf-8");
        this.ig.add(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.options.onWarning?.(`Failed to read ignore file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    for (const ignoreFile of await findNestedGitignoreFiles(
      rootPath,
      (relativeDirectory) => this.ig.ignores(`${relativeDirectory}/`),
      this.options.signal,
    )) {
      this.options.signal?.throwIfAborted();
      const directory = path.dirname(path.relative(rootPath, ignoreFile.path)).replace(/\\/g, "/");
      this.ig.add(scopeGitignorePatterns(ignoreFile.content, directory));
    }

    if (this.options.userExcludePatterns) {
      this.ig.add(this.options.userExcludePatterns);
    }
  }

  shouldIgnore(relativePath: string, sizeBytes: number): IgnoreResult {
    const maxSize = this.options.maxFileSizeBytes ?? DEFAULT_FILE_SIZE_CONFIG.maxScanFileBytes;
    if (sizeBytes > maxSize) {
      return { ignored: true, reason: `exceeds max file size (${(sizeBytes / 1_000_000).toFixed(1)}MB)` };
    }
    if (this.ig.ignores(relativePath)) {
      return { ignored: true, reason: "matches ignore pattern" };
    }
    return { ignored: false };
  }
}

async function findNestedGitignoreFiles(
  rootPath: string,
  shouldPrune: (relativeDirectory: string) => boolean,
  signal?: AbortSignal,
): Promise<NestedIgnoreFile[]> {
  const results: NestedIgnoreFile[] = [];

  async function visit(directory: string): Promise<void> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === ".svn" || entry.name === ".hg") continue;

      const childDirectory = path.join(directory, entry.name);
      const relativeDirectory = path.relative(rootPath, childDirectory).replace(/\\/g, "/");
      if (shouldPrune(relativeDirectory)) continue;

      const ignoreFile = path.join(childDirectory, ".gitignore");
      try {
        const content = await readFile(ignoreFile, "utf-8");
        results.push({ path: ignoreFile, content });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Preserve the warning behavior in loadIgnoreFiles without probing the
          // same file a second time. Unreadable files are simply not loaded.
        }
      }

      await visit(childDirectory);
    }
  }

  await visit(rootPath);
  return results;
}

function scopeGitignorePatterns(content: string, directory: string): string[] {
  const escapedDirectory = escapeIgnoreDirectory(directory);
  return content
    .split(/\r?\n/)
    .flatMap((line) => scopeGitignorePattern(line, escapedDirectory));
}

function scopeGitignorePattern(line: string, directory: string): string[] {
  if (!line || line.startsWith("#")) return [line];

  const negated = line.startsWith("!");
  const pattern = negated ? line.slice(1) : line;
  if (!pattern) return [line];

  const directoryOnly = pattern.endsWith("/");
  const patternBody = directoryOnly ? pattern.slice(0, -1) : pattern;
  const hasInternalSlash = patternBody.includes("/");

  const scopedPatterns = pattern.startsWith("/")
    ? [`${directory}/${pattern.slice(1)}`]
    : hasInternalSlash
      ? [`${directory}/${pattern}`]
      : [`${directory}/${pattern}`, `${directory}/**/${pattern}`];

  return scopedPatterns.map((scopedPattern) => negated ? `!${scopedPattern}` : scopedPattern);
}

function escapeIgnoreDirectory(directory: string): string {
  return directory
    .split("/")
    .map((segment) => {
      let escaped = segment.replace(/([\\*?\[\]])/g, "\\$1");
      if (escaped.startsWith("#") || escaped.startsWith("!")) {
        escaped = `\\${escaped}`;
      }
      return escaped;
    })
    .join("/");
}
