import * as fs from 'fs';
import * as path from 'path';

export type ProgressCallback = (message: string) => void;

/**
 * Manages the include graph for TableGen files.
 * Builds relationships between files based on include statements.
 */
export class IncludeGraph {
    // Root file -> include paths from compile commands
    private rootFiles: Map<string, string[]> = new Map();

    // File -> files it directly includes (in order)
    private forwardIncludes: Map<string, string[]> = new Map();

    // File -> files that directly include it
    private reverseIncludes: Map<string, string[]> = new Map();

    // File -> its root file (cached)
    private fileToRoot: Map<string, string> = new Map();

    // File -> all files visible from it (in include order, cached)
    private visibleFilesCache: Map<string, string[]> = new Map();

    private progressCallback?: ProgressCallback;

    setProgressCallback(callback: ProgressCallback): void {
        this.progressCallback = callback;
    }

    private log(message: string): void {
        this.progressCallback?.(message);
    }

    /**
     * Initialize the include graph from compile commands
     */
    initialize(rootFileMap: Map<string, string[]>): void {
        this.rootFiles = new Map(rootFileMap);
        this.forwardIncludes.clear();
        this.reverseIncludes.clear();
        this.fileToRoot.clear();
        this.visibleFilesCache.clear();

        this.log(`Building include graph for ${this.rootFiles.size} root files...`);

        // For each root file, recursively parse includes
        let processedCount = 0;
        for (const [rootFile, includePaths] of this.rootFiles) {
            this.log(`Processing root: ${path.basename(rootFile)}`);
            this.buildIncludeTree(rootFile, includePaths, new Set());
            processedCount++;
        }

        this.log(`Include graph built: ${this.forwardIncludes.size} files processed`);
    }

    /**
     * Recursively build the include tree starting from a file
     */
    private buildIncludeTree(
        filePath: string,
        includePaths: string[],
        visited: Set<string>
    ): void {
        const normalizedPath = path.normalize(filePath);

        if (visited.has(normalizedPath)) {
            return; // Avoid cycles
        }
        visited.add(normalizedPath);

        // Parse includes from this file
        const includes = this.parseIncludes(normalizedPath, includePaths);

        if (includes.length > 0) {
            this.forwardIncludes.set(normalizedPath, includes);
        }

        // Build reverse map
        for (const includedFile of includes) {
            if (!this.reverseIncludes.has(includedFile)) {
                this.reverseIncludes.set(includedFile, []);
            }
            this.reverseIncludes.get(includedFile)!.push(normalizedPath);
        }

        // Recursively process included files
        for (const includedFile of includes) {
            this.buildIncludeTree(includedFile, includePaths, visited);
        }
    }

    /**
     * Parse include statements from a file and resolve them
     */
    private parseIncludes(filePath: string, includePaths: string[]): string[] {
        if (!fs.existsSync(filePath)) {
            return [];
        }

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return [];
        }

        const includes: string[] = [];
        const includeRegex = /^\s*include\s+"([^"]+)"/gm;
        let match;

        while ((match = includeRegex.exec(content)) !== null) {
            const includeName = match[1];
            const resolved = this.resolveInclude(includeName, filePath, includePaths);
            if (resolved) {
                includes.push(resolved);
            }
        }

        return includes;
    }

    /**
     * Resolve an include path to an absolute file path
     */
    private resolveInclude(
        includeName: string,
        fromFile: string,
        includePaths: string[]
    ): string | undefined {
        // First try relative to the including file
        const fromDir = path.dirname(fromFile);
        const relativePath = path.join(fromDir, includeName);
        if (fs.existsSync(relativePath)) {
            return path.normalize(relativePath);
        }

        // Then try each include path
        for (const incPath of includePaths) {
            const fullPath = path.join(incPath, includeName);
            if (fs.existsSync(fullPath)) {
                return path.normalize(fullPath);
            }
        }

        return undefined;
    }

    /**
     * Find the root file for a given file by walking up the include chain
     */
    findRootFile(filePath: string): string | undefined {
        const normalizedPath = path.normalize(filePath);

        // Check cache
        if (this.fileToRoot.has(normalizedPath)) {
            return this.fileToRoot.get(normalizedPath);
        }

        // If this file is a root file
        if (this.rootFiles.has(normalizedPath)) {
            this.fileToRoot.set(normalizedPath, normalizedPath);
            return normalizedPath;
        }

        // Walk up the reverse include chain
        const visited = new Set<string>();
        const queue = [normalizedPath];

        while (queue.length > 0) {
            const current = queue.shift()!;

            if (visited.has(current)) continue;
            visited.add(current);

            // Check if this is a root file
            if (this.rootFiles.has(current)) {
                // Cache the result for all visited files
                for (const file of visited) {
                    this.fileToRoot.set(file, current);
                }
                return current;
            }

            // Add parents to queue
            const parents = this.reverseIncludes.get(current) || [];
            for (const parent of parents) {
                if (!visited.has(parent)) {
                    queue.push(parent);
                }
            }
        }

        return undefined;
    }

    /**
     * Get all files visible from a given file (in include order).
     * This includes:
     * - All files that are included before this file in the compilation unit
     * - All files that this file includes (directly or transitively)
     */
    getVisibleFiles(filePath: string): string[] {
        const normalizedPath = path.normalize(filePath);

        // Check cache
        if (this.visibleFilesCache.has(normalizedPath)) {
            return this.visibleFilesCache.get(normalizedPath)!;
        }

        // Find the root file
        const rootFile = this.findRootFile(normalizedPath);
        if (!rootFile) {
            return [];
        }

        // Collect files in two phases:
        // 1. All files from root up to and including target (in include order)
        // 2. All files that target includes (transitively)

        const visibleFiles: string[] = [];
        const visited = new Set<string>();

        // Phase 1: Collect files from root to target
        const collectUpToTarget = (file: string): boolean => {
            if (visited.has(file)) return false;
            visited.add(file);
            visibleFiles.push(file);

            if (file === normalizedPath) {
                return true; // Found target
            }

            const includes = this.forwardIncludes.get(file) || [];
            for (const includedFile of includes) {
                if (collectUpToTarget(includedFile)) {
                    return true; // Target found in this branch
                }
            }
            return false;
        };

        // Phase 2: Collect all includes from target (transitively)
        const collectAllIncludes = (file: string): void => {
            const includes = this.forwardIncludes.get(file) || [];
            for (const includedFile of includes) {
                if (visited.has(includedFile)) continue;
                visited.add(includedFile);
                visibleFiles.push(includedFile);
                collectAllIncludes(includedFile);
            }
        };

        collectUpToTarget(rootFile);
        collectAllIncludes(normalizedPath);

        // Cache the result
        this.visibleFilesCache.set(normalizedPath, visibleFiles);

        return visibleFiles;
    }

    /**
     * Get the include paths for a given file's compilation unit
     */
    getIncludePaths(filePath: string): string[] {
        const rootFile = this.findRootFile(path.normalize(filePath));
        if (!rootFile) {
            return [];
        }
        return this.rootFiles.get(rootFile) || [];
    }

    /**
     * Check if the graph has been initialized with any root files
     */
    hasRootFiles(): boolean {
        return this.rootFiles.size > 0;
    }

    /**
     * Get all root files
     */
    getRootFiles(): string[] {
        return Array.from(this.rootFiles.keys());
    }

    /**
     * Clear all cached data (for reindexing)
     */
    clear(): void {
        this.rootFiles.clear();
        this.forwardIncludes.clear();
        this.reverseIncludes.clear();
        this.fileToRoot.clear();
        this.visibleFilesCache.clear();
    }

    /**
     * Get all files in the include graph
     */
    getAllFiles(): string[] {
        const allFiles = new Set<string>();

        // Add all root files
        for (const rootFile of this.rootFiles.keys()) {
            allFiles.add(rootFile);
        }

        // Add all files from forward includes
        for (const [file, includes] of this.forwardIncludes) {
            allFiles.add(file);
            for (const inc of includes) {
                allFiles.add(inc);
            }
        }

        return Array.from(allFiles);
    }
}


