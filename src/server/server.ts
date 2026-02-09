import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    DefinitionParams,
    Location,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    DocumentSymbolParams,
    SymbolInformation,
    SymbolKind as LSPSymbolKind,
    Range as LSPRange,
    Position as LSPPosition,
    PrepareRenameParams,
    HoverParams,
    Hover,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';

import { parseTableGen } from './parser';
import { SymbolTable, SymbolCollector } from './symbols';
import { IncludeGraph } from './includeGraph';
import { parseCompileCommands, buildRootFileMap } from './compileCommands';
import { ParsedFile, SymbolKind, FieldAccess, Expression, MultiClassDef, Statement } from './types';
import { TypeSystem, TypeCollector, TypeInfo } from './typeSystem';

// Create connection and document manager
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Global state
const symbolTable = new SymbolTable();
const typeSystem = new TypeSystem();
const includeGraph = new IncludeGraph();
const parsedFiles = new Map<string, ParsedFile>();
const indexedFiles = new Set<string>(); // Track which files have been indexed

// Workspace state
let workspaceFolders: string[] = [];
let compileCommandsPath: string = '';

// Track initialization state
let isGraphBuilt = false;
let isBuildingGraph = false;

// Helper functions for status and logging
function sendStatus(message: string, type: 'progress' | 'ready' | 'error') {
    try {
        connection.sendNotification('tablegen/status', { message, type });
    } catch {
        // Ignore
    }
}

function sendLog(message: string) {
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').slice(0, 23);
    connection.console.log(`[${timestamp}] ${message}`);
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
    workspaceFolders = params.workspaceFolders?.map(f =>
        f.uri.replace('file://', '')
    ) || [];

    sendLog('TableGen Language Server initializing...');
    sendLog(`Workspace folders: ${workspaceFolders.join(', ')}`);

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            renameProvider: {
                prepareProvider: true
            },
            documentSymbolProvider: true,
            hoverProvider: true,
        }
    };
});

connection.onInitialized(async () => {
    sendLog('Server initialized, waiting for configuration...');
    // Request configuration from client
    try {
        const config = await connection.workspace.getConfiguration('tablegen');
        compileCommandsPath = config?.compileCommandsPath || '';
        sendLog(`Configuration: compileCommandsPath = "${compileCommandsPath}"`);
    } catch {
        sendLog('Could not get configuration, using defaults');
    }
    await buildIncludeGraph();
});

// Handle configuration changes
connection.onDidChangeConfiguration(async (change) => {
    const config = change.settings?.tablegen;
    if (config) {
        const newCompilePath = config.compileCommandsPath || '';
        if (newCompilePath !== compileCommandsPath) {
            compileCommandsPath = newCompilePath;
            sendLog(`Configuration changed: compileCommandsPath = "${compileCommandsPath}"`);
            await forceReindex();
        }
    }
});

/**
 * Resolve VSCode-style variables in a path:
 * - ${env:VAR_NAME} -> environment variable
 * - ${workspaceFolder} -> first workspace folder
 */
function resolveVariables(inputPath: string): string {
    let resolved = inputPath;

    // Resolve ${env:VAR_NAME}
    resolved = resolved.replace(/\$\{env:([^}]+)\}/g, (_, varName) => {
        return process.env[varName] || '';
    });

    // Resolve ${workspaceFolder}
    if (workspaceFolders.length > 0) {
        resolved = resolved.replace(/\$\{workspaceFolder\}/g, workspaceFolders[0]);
    }

    return resolved;
}

function getCompileCommandsFullPath(): string {
    // First resolve any variables in the configured path
    const resolvedPath = resolveVariables(compileCommandsPath);

    if (resolvedPath && path.isAbsolute(resolvedPath)) {
        return resolvedPath;
    }

    // Use relative path from first workspace folder, or default name
    const fileName = resolvedPath || 'tablegen_compile_commands.yml';
    if (workspaceFolders.length > 0) {
        return path.join(workspaceFolders[0], fileName);
    }

    return fileName;
}

/**
 * Build the include graph from compile commands.
 * This is fast - only parses include statements, not full files.
 */
async function buildIncludeGraph(): Promise<void> {
    if (isBuildingGraph) {
        return;
    }

    isBuildingGraph = true;
    isGraphBuilt = false;

    try {
        const ccPath = getCompileCommandsFullPath();
        sendLog(`Looking for compile commands at: ${ccPath}`);

        if (!fs.existsSync(ccPath)) {
            sendLog('Compile commands file not found. Symbol resolution will not work.');
            sendLog('Please set tablegen.compileCommandsPath or create tablegen_compile_commands.yml');
            sendStatus('No compile commands', 'error');
            isGraphBuilt = true;
            return;
        }

        sendLog('Parsing compile commands...');
        sendStatus('Building include graph...', 'progress');

        const commands = parseCompileCommands(ccPath);
        sendLog(`Found ${commands.length} compilation units`);

        if (commands.length === 0) {
            sendLog('No compilation units found in compile commands file');
            sendStatus('No compilation units', 'error');
            isGraphBuilt = true;
            return;
        }

        // Build root file map
        const rootFileMap = buildRootFileMap(commands);

        // Build include graph (fast - only regex parsing for includes)
        const startTime = Date.now();
        includeGraph.setProgressCallback((msg) => sendLog(msg));
        includeGraph.initialize(rootFileMap);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        sendLog(`Include graph built in ${elapsed}s`);
        sendStatus('TableGen ready', 'ready');

        isGraphBuilt = true;
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        sendLog(`Error building include graph: ${errorMsg}`);
        sendStatus('Graph build failed', 'error');
    } finally {
        isBuildingGraph = false;
    }
}

/**
 * Ensure all files visible from a given file are indexed.
 * This is called lazily when we need to look up symbols.
 */
async function ensureFilesIndexed(filePath: string): Promise<boolean> {
    // Wait for graph to be built
    while (isBuildingGraph) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!isGraphBuilt || !includeGraph.hasRootFiles()) {
        return false;
    }

    const normalizedPath = path.normalize(filePath);

    // Get visible files for this file
    const visibleFiles = includeGraph.getVisibleFiles(normalizedPath);
    if (visibleFiles.length === 0) {
        return false;
    }

    // Find files that need to be indexed
    const toIndex: string[] = [];
    for (const file of visibleFiles) {
        if (!indexedFiles.has(file)) {
            toIndex.push(file);
        }
    }

    if (toIndex.length === 0) {
        // All files already indexed
        return true;
    }

    sendLog(`Lazy indexing: ${toIndex.length} files for ${path.basename(filePath)}`);
    sendStatus(`Indexing: ${toIndex.length} files...`, 'progress');

    const startTime = Date.now();
    let indexed = 0;
    let errors = 0;

    for (const file of toIndex) {
        try {
            const uri = 'file://' + file;
            parseAndIndexFile(uri);
            indexedFiles.add(file);
            indexed++;
        } catch (e) {
            errors++;
            sendLog(`Error indexing ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Second pass: register composite defm symbols now that all multiclass
    // definitions are available in parsedFiles
    for (const file of toIndex) {
        const uri = 'file://' + file;
        const parsed = parsedFiles.get(uri);
        if (parsed) {
            registerCompositeDefmSymbols(parsed, uri);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    sendLog(`Indexed ${indexed} files (${errors} errors) in ${elapsed}s`);
    sendStatus('TableGen ready', 'ready');

    return true;
}

/**
 * Parse and index a single file
 */
function parseAndIndexFile(uri: string): ParsedFile | undefined {
    let content: string;
    try {
        const filePath = uri.replace('file://', '');
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return undefined;
    }

    const parsed = parseTableGen(content, uri);
    parsedFiles.set(uri, parsed);

    // Collect symbols
    symbolTable.clearFile(uri);
    const symbolCollector = new SymbolCollector(symbolTable, uri);
    symbolCollector.collect(parsed);

    // Collect type information
    typeSystem.clearFile(uri);
    const typeCollector = new TypeCollector(typeSystem, uri);
    typeCollector.collect(parsed);

    return parsed;
}

/**
 * Find a MultiClassDef node by name across all parsed files.
 */
function findMulticlassNode(name: string): MultiClassDef | undefined {
    for (const parsed of parsedFiles.values()) {
        for (const stmt of parsed.statements) {
            if (stmt.type === 'MultiClassDef' && stmt.name.name === name) {
                return stmt;
            }
        }
    }
    return undefined;
}

/**
 * Collect all def name suffixes produced by a multiclass body.
 * Handles direct defs and nested defm instantiations recursively.
 */
function collectDefSuffixes(mc: MultiClassDef): string[] {
    const suffixes: string[] = [];
    collectDefSuffixesFromBody(mc.body, suffixes);
    return suffixes;
}

function collectDefSuffixesFromBody(body: Statement[], suffixes: string[]): void {
    for (const stmt of body) {
        if (stmt.type === 'RecordDef' && stmt.name) {
            suffixes.push(stmt.name.name);
        } else if (stmt.type === 'DefmDef' && stmt.name) {
            // Nested defm: composite suffix = defm_name + sub-multiclass suffixes
            for (const parent of stmt.parentClasses) {
                const nestedMc = findMulticlassNode(parent.name.name);
                if (nestedMc) {
                    for (const sub of collectDefSuffixes(nestedMc)) {
                        suffixes.push(stmt.name.name + sub);
                    }
                }
            }
        } else if (stmt.type === 'ForeachStatement' || stmt.type === 'IfStatement') {
            // Recurse into foreach/if bodies
            if (stmt.type === 'ForeachStatement') {
                collectDefSuffixesFromBody(stmt.body, suffixes);
            } else {
                collectDefSuffixesFromBody(stmt.thenBody, suffixes);
                collectDefSuffixesFromBody(stmt.elseBody, suffixes);
            }
        }
    }
}

/**
 * Register composite defm symbols for a parsed file.
 * For each named defm that references a multiclass, register
 * defm_name + def_suffix as a global symbol pointing to the defm.
 */
function registerCompositeDefmSymbols(parsed: ParsedFile, uri: string): void {
    registerCompositeDefmSymbolsFromStatements(parsed.statements, uri);
}

function registerCompositeDefmSymbolsFromStatements(statements: Statement[], uri: string): void {
    for (const stmt of statements) {
        if (stmt.type === 'DefmDef' && stmt.name) {
            const defmName = stmt.name.name;
            const defmLocation = { uri, range: stmt.name.range };
            for (const parent of stmt.parentClasses) {
                const mcDef = findMulticlassNode(parent.name.name);
                if (mcDef) {
                    const suffixes = collectDefSuffixes(mcDef);
                    for (const suffix of suffixes) {
                        symbolTable.addSymbol({
                            name: defmName + suffix,
                            kind: 'def',
                            location: defmLocation,
                        });
                    }
                }
            }
        } else if (stmt.type === 'DefsetDef' || stmt.type === 'ForeachStatement') {
            // Recurse into defset/foreach bodies where defm can appear
            registerCompositeDefmSymbolsFromStatements(stmt.body, uri);
        } else if (stmt.type === 'IfStatement') {
            registerCompositeDefmSymbolsFromStatements(stmt.thenBody, uri);
            registerCompositeDefmSymbolsFromStatements(stmt.elseBody, uri);
        }
    }
}

async function ensureGraphBuilt(): Promise<void> {
    if (!isGraphBuilt && !isBuildingGraph) {
        await buildIncludeGraph();
    }

    while (isBuildingGraph) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

async function forceReindex(): Promise<void> {
    sendLog('Force reindex requested...');

    // Clear all in-memory state
    symbolTable.clear();
    typeSystem.clear();
    parsedFiles.clear();
    indexedFiles.clear();
    includeGraph.clear();

    // Reset state
    isGraphBuilt = false;
    isBuildingGraph = false;

    // Rebuild the include graph (files will be indexed lazily)
    await buildIncludeGraph();
}

// Handle reindex request from client
connection.onRequest('tablegen/reindex', async () => {
    await forceReindex();
    return { success: true };
});

// Document change handlers
documents.onDidOpen(async (event) => {
    const filePath = event.document.uri.replace('file://', '');
    await ensureFilesIndexed(filePath);
});

documents.onDidChangeContent((event) => {
    const uri = event.document.uri;
    const content = event.document.getText();

    // Re-parse the changed file
    const parsed = parseTableGen(content, uri);
    parsedFiles.set(uri, parsed);

    // Re-collect symbols
    symbolTable.clearFile(uri);
    const symbolCollector = new SymbolCollector(symbolTable, uri);
    symbolCollector.collect(parsed);

    // Re-collect type information
    typeSystem.clearFile(uri);
    const typeCollector = new TypeCollector(typeSystem, uri);
    typeCollector.collect(parsed);

    // Re-register composite defm symbols (multiclasses already indexed from initial pass)
    registerCompositeDefmSymbols(parsed, uri);
});

documents.onDidClose(() => {
    // Keep parsed data for cross-file references
});

// Go to Definition
connection.onDefinition(async (params: DefinitionParams): Promise<Location | null> => {
    await ensureGraphBuilt();

    const uri = params.textDocument.uri;
    const filePath = uri.replace('file://', '');
    const line = params.position.line;
    const character = params.position.character;

    // Check if we have compile commands
    if (!includeGraph.hasRootFiles()) {
        sendLog('No compile commands loaded, cannot resolve definitions');
        return null;
    }

    // Find the root file for this file
    const rootFile = includeGraph.findRootFile(filePath);
    if (!rootFile) {
        sendLog(`File not in any compilation unit: ${path.basename(filePath)}`);
        return null;
    }

    // Ensure all visible files are indexed
    const indexed = await ensureFilesIndexed(filePath);
    if (!indexed) {
        sendLog(`Could not index files for: ${path.basename(filePath)}`);
        return null;
    }

    // Get all files visible from this file
    const visibleFiles = includeGraph.getVisibleFiles(filePath);
    if (visibleFiles.length === 0) {
        sendLog(`No visible files for: ${path.basename(filePath)}`);
        return null;
    }

    const doc = documents.get(uri);
    if (!doc) return null;

    // Check if we're in a field access context (e.g., X.field)
    if (isFieldAccessContext(doc, params.position)) {
        return resolveFieldAccessDefinition(doc, params.position, uri, visibleFiles);
    }

    // Find what symbol is at this position
    const symbolInfo = symbolTable.getSymbolAtPosition(uri, line, character);

    let symbolName: string | undefined;
    let symbolScope: string | undefined;

    if (symbolInfo) {
        symbolName = symbolInfo.name;
        symbolScope = symbolInfo.scope;
    } else {
        const word = getWordAtPosition(doc, params.position);
        if (!word) return null;

        symbolName = word;
    }

    // Search for definition only in visible files
    const visibleUris = new Set(visibleFiles.map(f => 'file://' + f));

    sendLog(`Looking for '${symbolName}' (scope: ${symbolScope || 'none'}) in ${visibleFiles.length} visible files`);

    const parsed = parsedFiles.get(uri);
    const containingScope = parsed ? findScopeAtPosition(parsed, params.position) : undefined;

    // First, try to resolve as a field in the current class hierarchy
    // This handles both:
    // 1. "let X = ..." where X is defined in a parent class
    // 2. References to fields like "X" that are defined in parent classes
    if (containingScope) {
        const fieldDef = resolveLetBindingTarget(symbolName, containingScope, visibleUris);
        if (fieldDef) {
            sendLog(`'${symbolName}' resolved to field definition in ${path.basename(fieldDef.uri)}`);
            return fieldDef;
        }
    }

    // Try scoped lookup (for template args, local variables, etc.)
    // But skip letBinding since let is never a definition
    if (symbolScope) {
        const def = symbolTable.findDefinition(symbolName, symbolScope);
        if (def && def.kind !== 'letBinding' && visibleUris.has(def.location.uri)) {
            sendLog(`Found scoped definition (${def.kind}) in ${path.basename(def.location.uri)}`);
            return {
                uri: def.location.uri,
                range: def.location.range
            };
        }
    }

    // Global lookup - but be careful about what we return
    // - letBinding: never a definition (it's an override)
    // - field: only valid if we're not in a class scope (otherwise it should have been found via type system)
    // - class, def, defm, multiclass, defset, defvar: these are valid global definitions
    const allDefs = symbolTable.findAllDefinitions(symbolName);

    // If we're in a class scope, don't return fields from unrelated classes
    // Fields should have been found via the type system (parent class chain)
    const isInClassScope = containingScope &&
        (containingScope.startsWith('class:') ||
         containingScope.startsWith('def:') ||
         containingScope.startsWith('multiclass:'));

    const validDefs = allDefs.filter(d => {
        // Never return letBinding
        if (d.kind === 'letBinding') return false;
        // If we're in a class scope, don't return random fields from other classes
        // They should have been found via type system lookup
        if (isInClassScope && d.kind === 'field') return false;
        return true;
    });

    sendLog(`Found ${validDefs.length} valid definitions for '${symbolName}' (filtered ${allDefs.length - validDefs.length} invalid)`);

    for (const def of validDefs) {
        if (visibleUris.has(def.location.uri)) {
            sendLog(`Found definition (${def.kind}) in visible file ${path.basename(def.location.uri)}`);
            return {
                uri: def.location.uri,
                range: def.location.range
            };
        }
    }

    sendLog(`Definition not found for '${symbolName}' in ${visibleFiles.length} visible files`);
    return null;
});

// Hover - placeholder for future type information display
connection.onHover(async (_params: HoverParams): Promise<Hover | null> => {
    // TODO: Implement hover with type information
    return null;
});

/**
 * Resolve a field access expression to its definition.
 * Handles both simple field access (X.field) and class instantiation field access (ClassName<args>.field).
 */
function resolveFieldAccessDefinition(
    doc: TextDocument,
    position: LSPPosition,
    uri: string,
    visibleFiles: string[]
): Location | null {
    const text = doc.getText();
    const offset = doc.offsetAt(position);

    // Find the word at cursor (the field name)
    let fieldEnd = offset;
    while (fieldEnd < text.length && /[a-zA-Z0-9_]/.test(text[fieldEnd])) {
        fieldEnd++;
    }

    let fieldStart = offset;
    while (fieldStart > 0 && /[a-zA-Z0-9_]/.test(text[fieldStart - 1])) {
        fieldStart--;
    }

    const fieldName = text.substring(fieldStart, fieldEnd);
    if (!fieldName) {
        sendLog('Field access: could not extract field name');
        return null;
    }

    // Find the dot
    let dotPos = fieldStart - 1;
    while (dotPos > 0 && /\s/.test(text[dotPos])) {
        dotPos--;
    }

    if (text[dotPos] !== '.') {
        sendLog('Field access: dot not found');
        return null;
    }

    // Find what's before the dot - could be identifier or ClassName<args>
    let objEnd = dotPos;
    while (objEnd > 0 && /\s/.test(text[objEnd - 1])) {
        objEnd--;
    }

    let className: string | null = null;

    // Check if it's a class instantiation (ends with >)
    if (text[objEnd - 1] === '>') {
        // Find the matching < by counting brackets
        let bracketCount = 1;
        let pos = objEnd - 2;
        while (pos >= 0 && bracketCount > 0) {
            if (text[pos] === '>') {
                bracketCount++;
            } else if (text[pos] === '<') {
                bracketCount--;
            }
            pos--;
        }

        if (bracketCount === 0) {
            // pos is now one before the <
            // The < is at pos + 1
            // The class name ends somewhere at or before pos

            // Skip any whitespace between class name and <
            let nameEnd = pos + 1; // Start just before <
            while (nameEnd > 0 && /\s/.test(text[nameEnd - 1])) {
                nameEnd--;
            }
            // Now nameEnd points to one after the last char of the class name

            let nameStart = nameEnd;
            while (nameStart > 0 && /[a-zA-Z0-9_]/.test(text[nameStart - 1])) {
                nameStart--;
            }

            className = text.substring(nameStart, nameEnd);
            sendLog(`Field access: class instantiation ${className}<...>.${fieldName}`);
        }
    } else {
        // Simple identifier
        let objStart = objEnd;
        while (objStart > 0 && /[a-zA-Z0-9_]/.test(text[objStart - 1])) {
            objStart--;
        }

        className = text.substring(objStart, objEnd);
        sendLog(`Field access: ${className}.${fieldName}`);
    }

    if (!className) {
        sendLog('Field access: could not extract class/object name');
        return null;
    }

    // Find the current scope (which class/def/multiclass we're in)
    const parsed = parsedFiles.get(uri);
    if (!parsed) {
        sendLog('Field access: file not parsed');
        return null;
    }

    const currentScope = findScopeAtPosition(parsed, position);
    sendLog(`Field access: current scope = ${currentScope || 'global'}`);

    // Try to resolve the type
    // First check if className is directly a class in the type system
    let resolvedClassName: string | null = null;

    const directClass = typeSystem.getClass(className);
    if (directClass) {
        // It's a class instantiation like ClassName<...>.field
        resolvedClassName = className;
        sendLog(`Field access: '${className}' is a class`);
    } else {
        // It might be a variable/argument - try to resolve its type
        const objectType = resolveIdentifierType(className, currentScope, uri);
        if (objectType && objectType.kind === 'class') {
            resolvedClassName = objectType.name;
            sendLog(`Field access: '${className}' has type '${resolvedClassName}'`);
        }
    }

    if (!resolvedClassName) {
        sendLog(`Field access: could not resolve type of '${className}'`);
        return null;
    }

    // Find the field in the class hierarchy
    const fieldInfo = typeSystem.findFieldDefinition(resolvedClassName, fieldName);
    if (!fieldInfo) {
        sendLog(`Field access: field '${fieldName}' not found in '${resolvedClassName}'`);
        return null;
    }

    // Check if the field's location is in visible files
    const visibleUris = new Set(visibleFiles.map(f => 'file://' + f));
    if (!visibleUris.has(fieldInfo.location.uri)) {
        sendLog(`Field access: field definition not in visible files`);
        return null;
    }

    sendLog(`Field access: found field '${fieldName}' in ${path.basename(fieldInfo.location.uri)}`);
    return {
        uri: fieldInfo.location.uri,
        range: fieldInfo.location.range
    };
}

/**
 * Find which class/def/multiclass scope contains the given position
 */
function findScopeAtPosition(parsed: ParsedFile, position: LSPPosition): string | undefined {
    for (const stmt of parsed.statements) {
        const scope = findScopeInStatement(stmt, position);
        if (scope) {
            return scope;
        }
    }
    return undefined;
}

/**
 * For a let statement, find the first def/defm/class in its body to use for field resolution.
 * This handles "let X = Y in { def Foo : Bar; }" where X is a field defined in Bar's hierarchy.
 * Recursively searches through nested let/foreach/if statements.
 */
function findFirstDefInLetBody(stmt: any): string | undefined {
    // Check direct body
    if (stmt.body) {
        for (const bodyStmt of stmt.body) {
            const result = findDefInStatement(bodyStmt);
            if (result) return result;
        }
    }
    // Check thenBody/elseBody for IfStatement
    if (stmt.thenBody) {
        for (const bodyStmt of stmt.thenBody) {
            const result = findDefInStatement(bodyStmt);
            if (result) return result;
        }
    }
    if (stmt.elseBody) {
        for (const bodyStmt of stmt.elseBody) {
            const result = findDefInStatement(bodyStmt);
            if (result) return result;
        }
    }
    return undefined;
}

/**
 * Helper to find a def/defm in a statement, recursing into nested structures.
 */
function findDefInStatement(stmt: any): string | undefined {
    if (stmt.type === 'RecordDef' && stmt.parentClasses?.length > 0) {
        return `class:${stmt.parentClasses[0].name.name}`;
    }
    if (stmt.type === 'DefmDef' && stmt.parentClasses?.length > 0) {
        return `class:${stmt.parentClasses[0].name.name}`;
    }
    if (stmt.type === 'ClassDef' && !stmt.isForwardDeclaration) {
        if (stmt.parentClasses?.length > 0) {
            return `class:${stmt.parentClasses[0].name.name}`;
        }
        return `class:${stmt.name.name}`;
    }
    // Recurse into nested statements
    if (stmt.type === 'LetStatement' || stmt.type === 'ForeachStatement' || stmt.type === 'IfStatement') {
        return findFirstDefInLetBody(stmt);
    }
    return undefined;
}

function findScopeInStatement(stmt: any, position: LSPPosition): string | undefined {
    // Check if position is within this statement
    if (!isPositionInRange(position, stmt.range)) {
        return undefined;
    }

    switch (stmt.type) {
        case 'ClassDef':
            // Check if we're in a nested let inside the class body
            for (const bodyStmt of stmt.body || []) {
                if (bodyStmt.type === 'LetStatement' && isPositionInRange(position, bodyStmt.range)) {
                    const letScope = findScopeInStatement(bodyStmt, position);
                    if (letScope) return letScope;
                }
            }
            return `class:${stmt.name.name}`;
        case 'RecordDef':
            if (stmt.name) {
                return `def:${stmt.name.name}`;
            }
            return undefined;
        case 'MultiClassDef':
            // Check inside the multiclass body for let statements
            sendLog(`MultiClassDef ${stmt.name.name}: checking ${(stmt.body || []).length} body statements`);
            for (const bodyStmt of stmt.body || []) {
                sendLog(`  Body stmt type: ${bodyStmt.type}, range: ${bodyStmt.range?.start?.line}-${bodyStmt.range?.end?.line}`);
                if (isPositionInRange(position, bodyStmt.range)) {
                    sendLog(`  Position is in this statement`);
                    const nested = findScopeInStatement(bodyStmt, position);
                    sendLog(`  Nested scope result: ${nested}`);
                    if (nested) {
                        return nested;
                    }
                }
            }
            // Fall back to multiclass scope if not in a more specific context
            sendLog(`  Falling back to multiclass scope`);
            return `multiclass:${stmt.name.name}`;
        case 'LetStatement':
            sendLog(`LetStatement: checking ${(stmt.body || []).length} body statements`);
            // Check nested statements first
            for (const bodyStmt of stmt.body || []) {
                const nested = findScopeInStatement(bodyStmt, position);
                if (nested) {
                    return nested;
                }
            }
            // If we're in the let but not in a nested def,
            // look at what defs are in the body to find field definitions
            const letResult = findFirstDefInLetBody(stmt);
            sendLog(`LetStatement: findFirstDefInLetBody returned: ${letResult}`);
            return letResult;
        case 'ForeachStatement':
            // Check nested statements first
            for (const bodyStmt of stmt.body || []) {
                const nested = findScopeInStatement(bodyStmt, position);
                if (nested) {
                    return nested;
                }
            }
            return undefined;
        case 'IfStatement':
            for (const bodyStmt of stmt.thenBody || []) {
                const nested = findScopeInStatement(bodyStmt, position);
                if (nested) {
                    return nested;
                }
            }
            for (const bodyStmt of stmt.elseBody || []) {
                const nested = findScopeInStatement(bodyStmt, position);
                if (nested) {
                    return nested;
                }
            }
            return undefined;
    }

    return undefined;
}

function isPositionInRange(position: LSPPosition, range: any): boolean {
    if (position.line < range.start.line || position.line > range.end.line) {
        return false;
    }
    if (position.line === range.start.line && position.character < range.start.character) {
        return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
        return false;
    }
    return true;
}

/**
 * Resolve a let binding target - find where the field is originally defined
 * in the parent class hierarchy.
 *
 * For example: let X = value in a class that inherits from a parent,
 * X might be defined in the parent class.
 */
function resolveLetBindingTarget(
    fieldName: string,
    scope: string,
    visibleUris: Set<string>
): Location | null {
    const scopeParts = scope.split(':');
    if (scopeParts.length !== 2) {
        return null;
    }

    const [scopeKind, scopeName] = scopeParts;
    if (scopeKind !== 'class' && scopeKind !== 'def' && scopeKind !== 'multiclass') {
        return null;
    }

    // Get the class/def info
    const classInfo = typeSystem.getClass(scopeName);
    if (!classInfo) {
        sendLog(`Let binding: class '${scopeName}' not found in type system`);
        return null;
    }

    // Search for the field in this class's own fields first
    const ownField = classInfo.fields.get(fieldName);
    if (ownField && visibleUris.has(ownField.location.uri)) {
        return {
            uri: ownField.location.uri,
            range: ownField.location.range
        };
    }

    // Search in parent classes
    for (const parentName of classInfo.parentClasses) {
        const fieldInfo = typeSystem.findFieldDefinition(parentName, fieldName);
        if (fieldInfo && visibleUris.has(fieldInfo.location.uri)) {
            return {
                uri: fieldInfo.location.uri,
                range: fieldInfo.location.range
            };
        }
    }

    // The field might also be a template argument in a parent class
    const allParents = typeSystem.getAllParentClasses(scopeName);
    for (const parentName of allParents) {
        const parentClass = typeSystem.getClass(parentName);
        if (parentClass) {
            for (const arg of parentClass.arguments) {
                if (arg.name === fieldName && visibleUris.has(arg.location.uri)) {
                    return {
                        uri: arg.location.uri,
                        range: arg.location.range
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Try to resolve the type of an identifier in the given scope
 */
function resolveIdentifierType(name: string, scope: string | undefined, uri: string): TypeInfo | undefined {
    // If we have a scope (e.g., class:Foo), check for template arguments first
    if (scope) {
        const scopeParts = scope.split(':');
        if (scopeParts.length === 2) {
            const [, scopeName] = scopeParts;
            const classInfo = typeSystem.getClass(scopeName);
            if (classInfo) {
                // Check template arguments
                for (const arg of classInfo.arguments) {
                    if (arg.name === name) {
                        sendLog(`Resolved '${name}' as template arg with type '${arg.type.name}'`);
                        return arg.type;
                    }
                }
            }
        }
    }

    // Check if it's a class/def
    const classInfo = typeSystem.getClass(name);
    if (classInfo) {
        // The identifier refers to a class/def directly
        // When accessing a field on a class name, we're accessing static fields
        return { kind: 'class', name: name };
    }

    // Check global symbols for defvar that might have a type
    const symbol = symbolTable.findDefinition(name, scope);
    if (symbol) {
        if (symbol.kind === 'defvar') {
            // For defvar, we need to look at what it's assigned to
            // This would require expression type inference which is more complex
            sendLog(`Found defvar '${name}' but expression type inference not yet implemented`);
        } else if (symbol.kind === 'templateArg') {
            // Template arg - already handled above
        } else if (symbol.kind === 'def' || symbol.kind === 'defm') {
            // This is a def/defm, its type is its name
            return { kind: 'class', name: symbol.name };
        }
    }

    return undefined;
}

// Prepare Rename
connection.onPrepareRename(async (params: PrepareRenameParams): Promise<LSPRange | null> => {
    await ensureGraphBuilt();

    const uri = params.textDocument.uri;
    const filePath = uri.replace('file://', '');
    const doc = documents.get(uri);
    if (!doc) return null;

    // Ensure files are indexed
    await ensureFilesIndexed(filePath);

    const word = getWordAtPosition(doc, params.position);
    if (!word) return null;

    const defs = symbolTable.findAllDefinitions(word);
    if (defs.length === 0) {
        const refs = symbolTable.findReferences(word);
        if (refs.length === 0) {
            return null;
        }
    }

    return getWordRangeAtPosition(doc, params.position);
});

// Rename
connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | null> => {
    await ensureGraphBuilt();

    const uri = params.textDocument.uri;
    const filePath = uri.replace('file://', '');
    const doc = documents.get(uri);
    if (!doc) return null;

    // Ensure files are indexed
    await ensureFilesIndexed(filePath);

    const word = getWordAtPosition(doc, params.position);
    if (!word) return null;

    // Get visible files for scope
    const visibleFiles = includeGraph.getVisibleFiles(filePath);
    const visibleUris = new Set(visibleFiles.map(f => 'file://' + f));

    const newName = params.newName;
    const changes: { [uri: string]: TextEdit[] } = {};

    // Find all definitions in visible files
    const defs = symbolTable.findAllDefinitions(word);
    for (const def of defs) {
        if (visibleUris.has(def.location.uri)) {
            if (!changes[def.location.uri]) {
                changes[def.location.uri] = [];
            }
            changes[def.location.uri].push({
                range: def.location.range,
                newText: newName
            });
        }
    }

    // Find all references in visible files
    const refs = symbolTable.findReferences(word);
    for (const ref of refs) {
        if (visibleUris.has(ref.location.uri)) {
            if (!changes[ref.location.uri]) {
                changes[ref.location.uri] = [];
            }
            changes[ref.location.uri].push({
                range: ref.location.range,
                newText: newName
            });
        }
    }

    return { changes };
});

// Document Symbols (outline)
connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<SymbolInformation[]> => {
    await ensureGraphBuilt();

    const uri = params.textDocument.uri;
    const filePath = uri.replace('file://', '');

    // Ensure this file is indexed
    await ensureFilesIndexed(filePath);

    const symbols = symbolTable.getAllSymbolsInFile(uri);

    return symbols
        .filter(s => !s.scope && s.name) // Filter out scoped symbols AND symbols with empty names
        .map(s => ({
            name: s.name,
            kind: symbolKindToLSP(s.kind),
            location: {
                uri: s.location.uri,
                range: s.location.range
            }
        }));
});

function symbolKindToLSP(kind: SymbolKind): LSPSymbolKind {
    switch (kind) {
        case 'class': return LSPSymbolKind.Class;
        case 'def': return LSPSymbolKind.Constant;
        case 'defm': return LSPSymbolKind.Constant;
        case 'multiclass': return LSPSymbolKind.Class;
        case 'defset': return LSPSymbolKind.Variable;
        case 'defvar': return LSPSymbolKind.Variable;
        case 'field': return LSPSymbolKind.Field;
        case 'templateArg': return LSPSymbolKind.TypeParameter;
        case 'foreachVar': return LSPSymbolKind.Variable;
        case 'letBinding': return LSPSymbolKind.Variable;
        default: return LSPSymbolKind.Variable;
    }
}

function getWordAtPosition(doc: TextDocument, position: LSPPosition): string | null {
    const text = doc.getText();
    const offset = doc.offsetAt(position);

    let start = offset;
    let end = offset;

    while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
        start--;
    }

    while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) {
        end++;
    }

    if (start === end) {
        return null;
    }

    return text.substring(start, end);
}

function isFieldAccessContext(doc: TextDocument, position: LSPPosition): boolean {
    const text = doc.getText();
    const offset = doc.offsetAt(position);

    let start = offset;
    while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
        start--;
    }

    if (start > 0 && text[start - 1] === '.') {
        return true;
    }

    return false;
}

function getWordRangeAtPosition(doc: TextDocument, position: LSPPosition): LSPRange | null {
    const text = doc.getText();
    const offset = doc.offsetAt(position);

    let start = offset;
    let end = offset;

    while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) {
        start--;
    }

    while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) {
        end++;
    }

    if (start === end) {
        return null;
    }

    return {
        start: doc.positionAt(start),
        end: doc.positionAt(end)
    };
}

// Listen
documents.listen(connection);
connection.listen();
