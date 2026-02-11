import * as fs from "fs";
import * as path from "path";

export interface CompileCommand {
  filepath: string;
  includePaths: string[];
}

/**
 * Parse tablegen_compile_commands.yml file.
 * Format:
 * --- !FileInfo:
 *   filepath: "/path/to/file.td"
 *   includes: "/path1;/path2;/path3"
 */
export function parseCompileCommands(filePath: string): CompileCommand[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const commands: CompileCommand[] = [];

  // Split by entries (--- !FileInfo:)
  const entries = content.split(/^---\s*!FileInfo:\s*$/m);

  for (const entry of entries) {
    if (!entry.trim()) continue;

    // Parse filepath
    const filepathMatch = entry.match(/^\s*filepath:\s*"([^"]+)"/m);
    if (!filepathMatch) continue;

    // Parse includes
    const includesMatch = entry.match(/^\s*includes:\s*"([^"]*)"/m);
    const includePaths = includesMatch
      ? includesMatch[1].split(";").filter((p) => p.trim().length > 0)
      : [];

    // Normalize the filepath (resolve .. and such)
    const normalizedPath = path.normalize(filepathMatch[1]);

    commands.push({
      filepath: normalizedPath,
      includePaths,
    });
  }

  // Deduplicate by filepath (keep first occurrence)
  const seen = new Set<string>();
  const deduplicated: CompileCommand[] = [];
  for (const cmd of commands) {
    if (!seen.has(cmd.filepath)) {
      seen.add(cmd.filepath);
      deduplicated.push(cmd);
    }
  }

  return deduplicated;
}

/**
 * Build a map from root file to its include paths
 */
export function buildRootFileMap(
  commands: CompileCommand[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const cmd of commands) {
    map.set(cmd.filepath, cmd.includePaths);
  }
  return map;
}
