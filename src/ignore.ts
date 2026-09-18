import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * gitignore-style rules that decide which files index_repo reads.
 *
 * Supported syntax (a subset of gitignore): blank lines and `#` comments are
 * skipped; `*` matches within one path segment, `?` one character, `**` any
 * number of segments, `[abc]` a character class; a pattern without `/`
 * matches a file or directory name at any depth; a pattern containing `/` is
 * anchored to the repo root (a leading `/` is optional); a trailing `/`
 * matches directories only; `!` re-includes; the last matching rule wins.
 * Not supported: `\` escapes and nested ignore files.
 */

export const CSIGNORE_FILE_NAME = ".csignore";

export type RuleSource = "default" | "csignore";

export interface IgnoreRule {
  /** The line as written (for diagnostics). */
  pattern: string;
  source: RuleSource;
  negated: boolean;
  dirOnly: boolean;
  /** Anchored rules test the root-relative path; others test the entry name. */
  anchored: boolean;
  regex: RegExp;
}

/**
 * Built-in rules, applied before `.csignore` so a project can re-include any
 * of them with `!`. Written in the same syntax users get.
 */
export const DEFAULT_IGNORE_PATTERNS = `
# Directories that never hold hand-written source worth searching.
node_modules/
.git/
dist/
build/
.next/
coverage/
.venv/
target/
.context-index/
__pycache__/
.idea/
.cache/
.pytest_cache/
.mypy_cache/
# Lockfiles, source maps and minified/bundled output.
package-lock.json
npm-shrinkwrap.json
pnpm-lock.yaml
yarn.lock
uv.lock
poetry.lock
Cargo.lock
Gemfile.lock
composer.lock
go.sum
*.min.js
*.min.jsx
*.min.ts
*.min.tsx
*.min.css
*.bundle.js
*.map
# Secrets: never put these in an index that search_code can read back.
.env
.env.*
!.env.example
*.pem
*.key
id_rsa*
id_ed25519*
# Media, archives and other non-source files (binaries are also caught by the NUL check).
*.svg
*.pdf
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.ico
*.bmp
*.woff
*.woff2
*.ttf
*.otf
*.eot
*.zip
*.tar
*.gz
*.tgz
*.bz2
*.7z
*.rar
*.jar
*.mp3
*.mp4
*.wav
*.mov
*.avi
*.pyc
*.class
*.o
*.so
*.dylib
*.dll
*.exe
*.wasm
*.sqlite
*.sqlite3
*.db
.DS_Store
# Ignore files themselves (.gitignore, .csignore, .prettierignore, ...).
.*ignore
`;

/** Translate one glob (already stripped of `!`, leading and trailing `/`) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        if (atSegmentStart && glob[i + 2] === "/") {
          re += "(?:.*/)?"; // `**/`: zero or more leading segments
          i += 3;
        } else {
          re += ".*"; // `/**` at the end, or `**` inside a segment
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close !== -1) {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = close + 1;
        continue;
      }
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export function parseIgnorePatterns(text: string, source: RuleSource): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;

    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.replace(/\/+$/, "");
    }
    let anchored = false;
    if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.replace(/^\/+/, "");
    }
    if (pattern.includes("/")) anchored = true;
    if (pattern === "") continue;

    rules.push({ pattern: line, source, negated, dirOnly, anchored, regex: globToRegExp(pattern) });
  }
  return rules;
}

export class IgnoreMatcher {
  constructor(private readonly rules: IgnoreRule[]) {}

  /**
   * The last rule matching `relPath` (root-relative, `/`-separated), or null.
   * The entry is ignored when that rule is not negated.
   */
  match(relPath: string, isDir: boolean): IgnoreRule | null {
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    let hit: IgnoreRule | null = null;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(rule.anchored ? relPath : name)) hit = rule;
    }
    return hit;
  }

  ignores(relPath: string, isDir: boolean): boolean {
    const rule = this.match(relPath, isDir);
    return rule !== null && !rule.negated;
  }
}

export interface LoadedIgnore {
  matcher: IgnoreMatcher;
  /** Rules read from `<root>/.csignore`, or null when the file does not exist. */
  csignoreRules: number | null;
}

/** Built-in defaults followed by the repo's `.csignore`, if any. */
export async function loadIgnoreMatcher(root: string): Promise<LoadedIgnore> {
  const defaults = parseIgnorePatterns(DEFAULT_IGNORE_PATTERNS, "default");
  let text: string | null;
  try {
    text = await fs.readFile(path.join(root, CSIGNORE_FILE_NAME), "utf8");
  } catch {
    text = null;
  }
  const own = text === null ? [] : parseIgnorePatterns(text, "csignore");
  return { matcher: new IgnoreMatcher([...defaults, ...own]), csignoreRules: text === null ? null : own.length };
}
