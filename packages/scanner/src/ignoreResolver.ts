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
}

const IGNORE_FILE_NAMES = [
  ".gitignore",
  ".cursorignore",
  ".aiderignore",
  ".continueignore",
  ".tcalcignore",
];

export class IgnoreResolver {
  private ig = ignore();

  constructor(private options: IgnoreResolverOptions = {}) {}

  async loadIgnoreFiles(rootPath: string): Promise<void> {
    const files = [...IGNORE_FILE_NAMES, ...(this.options.additionalIgnoreFiles ?? [])];
    for (const fileName of files) {
      try {
        const content = await readFile(path.join(rootPath, fileName), "utf-8");
        this.ig.add(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.options.onWarning?.(`Failed to read ignore file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    for (const ignoreFile of await findNestedGitignoreFiles(rootPath)) {
      try {
        const content = await readFile(ignoreFile, "utf-8");
        const directory = path.dirname(path.relative(rootPath, ignoreFile)).replace(/\\/g, "/");
        this.ig.add(scopeGitignorePatterns(content, directory));
      } catch (error) {
        this.options.onWarning?.(`Failed to read ignore file ${path.relative(rootPath, ignoreFile).replace(/\\/g, "/")}: ${error instanceof Error ? error.message : String(error)}`);
      }
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

async function findNestedGitignoreFiles(rootPath: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === ".svn" || entry.name === ".hg") continue;

      const childDirectory = path.join(directory, entry.name);
      const ignoreFile = path.join(childDirectory, ".gitignore");
      try {
        await readFile(ignoreFile, "utf-8");
        results.push(ignoreFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          results.push(ignoreFile);
        }
      }

      await visit(childDirectory);
    }
  }

  await visit(rootPath);
  return results;
}

function scopeGitignorePatterns(content: string, directory: string): string[] {
  return content
    .split(/\r?\n/)
    .flatMap((line) => scopeGitignorePattern(line, directory));
}

function scopeGitignorePattern(line: string, directory: string): string[] {
  if (!line || line.startsWith("#")) return [line];

  const negated = line.startsWith("!");
  const pattern = negated ? line.slice(1) : line;
  if (!pattern) return [line];

  const scopedPatterns = pattern.startsWith("/")
    ? [`${directory}/${pattern.slice(1)}`]
    : pattern.includes("/")
      ? [`${directory}/${pattern}`]
      : [`${directory}/${pattern}`, `${directory}/**/${pattern}`];

  return scopedPatterns.map((scopedPattern) => negated ? `!${scopedPattern}` : scopedPattern);
}
