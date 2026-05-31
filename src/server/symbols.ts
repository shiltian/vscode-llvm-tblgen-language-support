import {
  Symbol,
  SymbolKind,
  SymbolReference,
  Location,
  Range,
  ParsedFile,
  Statement,
  ClassDef,
  RecordDef,
  MultiClassDef,
  DefmDef,
  DefsetDef,
  DefvarDef,
  FieldDef,
  LetStatement,
  ForeachStatement,
  TemplateArg,
  Expression,
  Identifier,
  ClassRef,
} from "./types";

export class SymbolTable {
  // Global symbols indexed by name
  private globalSymbols: Map<string, Symbol[]> = new Map();

  // Scoped symbols: scope -> name -> symbols
  private scopedSymbols: Map<string, Map<string, Symbol[]>> = new Map();

  // All symbols/references by name for hot rename and definition paths
  private symbolsByName: Map<string, Symbol[]> = new Map();
  private referencesByName: Map<string, SymbolReference[]> = new Map();

  // File -> symbols mapping for incremental updates
  private fileSymbols: Map<string, Symbol[]> = new Map();
  private fileReferences: Map<string, SymbolReference[]> = new Map();
  private fileSymbolLineIndex: Map<string, Map<number, Symbol[]>> = new Map();
  private fileReferenceLineIndex: Map<string, Map<number, SymbolReference[]>> =
    new Map();

  clear(): void {
    this.globalSymbols.clear();
    this.scopedSymbols.clear();
    this.symbolsByName.clear();
    this.referencesByName.clear();
    this.fileSymbols.clear();
    this.fileReferences.clear();
    this.fileSymbolLineIndex.clear();
    this.fileReferenceLineIndex.clear();
  }

  clearFile(uri: string): void {
    // Remove old symbols from this file
    const oldSymbols = this.fileSymbols.get(uri) || [];
    for (const sym of oldSymbols) {
      if (sym.scope) {
        const scopeMap = this.scopedSymbols.get(sym.scope);
        if (scopeMap) {
          const syms = scopeMap.get(sym.name);
          if (syms) {
            this.removeFromArray(syms, sym);
            if (syms.length === 0) {
              scopeMap.delete(sym.name);
            }
          }
          if (scopeMap.size === 0) {
            this.scopedSymbols.delete(sym.scope);
          }
        }
      } else {
        const syms = this.globalSymbols.get(sym.name);
        if (syms) {
          this.removeFromArray(syms, sym);
          if (syms.length === 0) {
            this.globalSymbols.delete(sym.name);
          }
        }
      }

      const byName = this.symbolsByName.get(sym.name);
      if (byName) {
        this.removeFromArray(byName, sym);
        if (byName.length === 0) {
          this.symbolsByName.delete(sym.name);
        }
      }
    }
    this.fileSymbols.delete(uri);
    this.fileSymbolLineIndex.delete(uri);

    // Remove old references from this file
    const oldRefs = this.fileReferences.get(uri) || [];
    for (const ref of oldRefs) {
      const refs = this.referencesByName.get(ref.name);
      if (refs) {
        this.removeFromArray(refs, ref);
        if (refs.length === 0) {
          this.referencesByName.delete(ref.name);
        }
      }
    }
    this.fileReferences.delete(uri);
    this.fileReferenceLineIndex.delete(uri);
  }

  addSymbol(symbol: Symbol): void {
    // Skip symbols with empty names
    if (!symbol.name) {
      return;
    }

    const uri = symbol.location.uri;

    // Track by file
    if (!this.fileSymbols.has(uri)) {
      this.fileSymbols.set(uri, []);
    }
    this.fileSymbols.get(uri)!.push(symbol);
    this.addToMapArray(this.symbolsByName, symbol.name, symbol);
    this.addToLineIndex(this.fileSymbolLineIndex, uri, symbol);

    // Add to appropriate index
    if (symbol.scope) {
      if (!this.scopedSymbols.has(symbol.scope)) {
        this.scopedSymbols.set(symbol.scope, new Map());
      }
      const scopeMap = this.scopedSymbols.get(symbol.scope)!;
      if (!scopeMap.has(symbol.name)) {
        scopeMap.set(symbol.name, []);
      }
      scopeMap.get(symbol.name)!.push(symbol);
    } else {
      if (!this.globalSymbols.has(symbol.name)) {
        this.globalSymbols.set(symbol.name, []);
      }
      this.globalSymbols.get(symbol.name)!.push(symbol);
    }
  }

  addReference(ref: SymbolReference): void {
    const uri = ref.location.uri;

    if (!this.fileReferences.has(uri)) {
      this.fileReferences.set(uri, []);
    }
    this.fileReferences.get(uri)!.push(ref);
    this.addToMapArray(this.referencesByName, ref.name, ref);
    this.addToLineIndex(this.fileReferenceLineIndex, uri, ref);
  }

  findDefinition(name: string, scope?: string): Symbol | undefined {
    // First check scoped symbols if scope is provided
    if (scope) {
      const scopeMap = this.scopedSymbols.get(scope);
      if (scopeMap) {
        const syms = scopeMap.get(name);
        if (syms && syms.length > 0) {
          // Prefer definitions over forward declarations
          const def = syms.find((s) => !s.isForwardDeclaration);
          return def || syms[0];
        }
      }
    }

    // Fall back to global symbols
    const syms = this.globalSymbols.get(name);
    if (syms && syms.length > 0) {
      // Prefer definitions over forward declarations
      const def = syms.find((s) => !s.isForwardDeclaration);
      return def || syms[0];
    }

    return undefined;
  }

  findAllDefinitions(name: string): Symbol[] {
    const results = [...(this.symbolsByName.get(name) || [])];

    // Sort: definitions first, then forward declarations
    results.sort((a, b) => {
      if (a.isForwardDeclaration && !b.isForwardDeclaration) return 1;
      if (!a.isForwardDeclaration && b.isForwardDeclaration) return -1;
      return 0;
    });

    return results;
  }

  findReferences(name: string): SymbolReference[] {
    return [...(this.referencesByName.get(name) || [])];
  }

  getAllSymbolsInFile(uri: string): Symbol[] {
    return this.fileSymbols.get(uri) || [];
  }

  getSymbolAtPosition(
    uri: string,
    line: number,
    character: number,
  ): { name: string; scope?: string } | undefined {
    // Check references first (more common)
    const refs = this.fileReferenceLineIndex.get(uri)?.get(line) || [];
    for (const ref of refs) {
      if (this.isPositionInRange(line, character, ref.location.range)) {
        return { name: ref.name, scope: ref.scope };
      }
    }

    // Check symbols
    const symbols = this.fileSymbolLineIndex.get(uri)?.get(line) || [];
    for (const sym of symbols) {
      if (this.isPositionInRange(line, character, sym.location.range)) {
        return { name: sym.name, scope: sym.scope };
      }
    }

    return undefined;
  }

  private isPositionInRange(
    line: number,
    character: number,
    range: Range,
  ): boolean {
    if (line < range.start.line || line > range.end.line) {
      return false;
    }
    if (line === range.start.line && character < range.start.character) {
      return false;
    }
    if (line === range.end.line && character > range.end.character) {
      return false;
    }
    return true;
  }

  private addToMapArray<T>(map: Map<string, T[]>, key: string, value: T): void {
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(value);
  }

  private removeFromArray<T>(values: T[], value: T): void {
    const idx = values.indexOf(value);
    if (idx >= 0) {
      values.splice(idx, 1);
    }
  }

  private addToLineIndex<T extends { location: Location }>(
    index: Map<string, Map<number, T[]>>,
    uri: string,
    value: T,
  ): void {
    let lineMap = index.get(uri);
    if (!lineMap) {
      lineMap = new Map();
      index.set(uri, lineMap);
    }

    for (
      let line = value.location.range.start.line;
      line <= value.location.range.end.line;
      line++
    ) {
      if (!lineMap.has(line)) {
        lineMap.set(line, []);
      }
      lineMap.get(line)!.push(value);
    }
  }

  // Export all symbols and references for caching
  exportData(): { symbols: Symbol[]; references: SymbolReference[] } {
    const symbols: Symbol[] = [];
    for (const syms of this.fileSymbols.values()) {
      symbols.push(...syms);
    }
    const references: SymbolReference[] = [];
    for (const refs of this.fileReferences.values()) {
      references.push(...refs);
    }
    return { symbols, references };
  }

  // Import symbols and references from cache
  importData(symbols: Symbol[], references: SymbolReference[]): void {
    this.clear();

    for (const sym of symbols) {
      this.addSymbol(sym);
    }

    for (const ref of references) {
      this.addReference(ref);
    }
  }
}

export class SymbolCollector {
  private symbolTable: SymbolTable;
  private uri: string;
  private currentScope: string | undefined;

  constructor(symbolTable: SymbolTable, uri: string) {
    this.symbolTable = symbolTable;
    this.uri = uri;
  }

  collect(file: ParsedFile): void {
    for (const stmt of file.statements) {
      this.collectStatement(stmt);
    }
  }

  private collectStatement(stmt: Statement): void {
    switch (stmt.type) {
      case "ClassDef":
        this.collectClass(stmt);
        break;
      case "RecordDef":
        this.collectRecord(stmt);
        break;
      case "MultiClassDef":
        this.collectMulticlass(stmt);
        break;
      case "DefmDef":
        this.collectDefm(stmt);
        break;
      case "DefsetDef":
        this.collectDefset(stmt);
        break;
      case "DefvarDef":
        this.collectDefvar(stmt);
        break;
      case "FieldDef":
        this.collectField(stmt);
        break;
      case "LetStatement":
        this.collectLet(stmt);
        break;
      case "ForeachStatement":
        this.collectForeach(stmt);
        break;
    }
  }

  private collectClass(stmt: ClassDef): void {
    // Add class symbol
    this.symbolTable.addSymbol({
      name: stmt.name.name,
      kind: "class",
      location: { uri: this.uri, range: stmt.name.range },
      isForwardDeclaration: stmt.isForwardDeclaration,
    });

    // Set scope for template args and body
    const previousScope = this.currentScope;
    this.currentScope = `class:${stmt.name.name}`;

    // Collect template args
    for (const arg of stmt.templateArgs) {
      this.symbolTable.addSymbol({
        name: arg.name.name,
        kind: "templateArg",
        location: { uri: this.uri, range: arg.name.range },
        scope: this.currentScope,
      });
    }

    // Collect references in parent classes
    for (const parent of stmt.parentClasses) {
      this.collectClassRef(parent);
    }

    // Collect body
    for (const bodyStmt of stmt.body) {
      this.collectStatement(bodyStmt);
    }

    this.currentScope = previousScope;
  }

  private collectRecord(stmt: RecordDef): void {
    if (stmt.name) {
      this.symbolTable.addSymbol({
        name: stmt.name.name,
        kind: "def",
        location: { uri: this.uri, range: stmt.name.range },
      });

      const previousScope = this.currentScope;
      this.currentScope = `def:${stmt.name.name}`;

      for (const parent of stmt.parentClasses) {
        this.collectClassRef(parent);
      }

      for (const bodyStmt of stmt.body) {
        this.collectStatement(bodyStmt);
      }

      this.currentScope = previousScope;
    } else {
      // Anonymous def
      for (const parent of stmt.parentClasses) {
        this.collectClassRef(parent);
      }
      for (const bodyStmt of stmt.body) {
        this.collectStatement(bodyStmt);
      }
    }
  }

  private collectMulticlass(stmt: MultiClassDef): void {
    this.symbolTable.addSymbol({
      name: stmt.name.name,
      kind: "multiclass",
      location: { uri: this.uri, range: stmt.name.range },
    });

    const previousScope = this.currentScope;
    this.currentScope = `multiclass:${stmt.name.name}`;

    for (const arg of stmt.templateArgs) {
      this.symbolTable.addSymbol({
        name: arg.name.name,
        kind: "templateArg",
        location: { uri: this.uri, range: arg.name.range },
        scope: this.currentScope,
      });
    }

    for (const parent of stmt.parentClasses) {
      this.collectClassRef(parent);
    }

    for (const bodyStmt of stmt.body) {
      this.collectStatement(bodyStmt);
    }

    this.currentScope = previousScope;
  }

  private collectDefm(stmt: DefmDef): void {
    if (stmt.name) {
      this.symbolTable.addSymbol({
        name: stmt.name.name,
        kind: "defm",
        location: { uri: this.uri, range: stmt.name.range },
      });
    }

    for (const parent of stmt.parentClasses) {
      this.collectClassRef(parent);
    }
  }

  private collectDefset(stmt: DefsetDef): void {
    this.symbolTable.addSymbol({
      name: stmt.name.name,
      kind: "defset",
      location: { uri: this.uri, range: stmt.name.range },
    });

    const previousScope = this.currentScope;
    this.currentScope = `defset:${stmt.name.name}`;

    for (const bodyStmt of stmt.body) {
      this.collectStatement(bodyStmt);
    }

    this.currentScope = previousScope;
  }

  private collectDefvar(stmt: DefvarDef): void {
    this.symbolTable.addSymbol({
      name: stmt.name.name,
      kind: "defvar",
      location: { uri: this.uri, range: stmt.name.range },
      scope: this.currentScope,
    });

    this.collectExpression(stmt.value);
  }

  private collectField(stmt: FieldDef): void {
    this.symbolTable.addSymbol({
      name: stmt.name.name,
      kind: "field",
      location: { uri: this.uri, range: stmt.name.range },
      scope: this.currentScope,
    });

    if (stmt.value) {
      this.collectExpression(stmt.value);
    }
  }

  private collectLet(stmt: LetStatement): void {
    for (const binding of stmt.bindings) {
      // Let bindings at top level are field overrides, not new symbols
      // But we still need to track the reference
      this.symbolTable.addReference({
        name: binding.name.name,
        location: { uri: this.uri, range: binding.name.range },
        scope: this.currentScope,
      });

      this.collectExpression(binding.value);
    }

    // Collect body statements with let bindings in scope
    const previousScope = this.currentScope;
    // Create a unique scope for let bindings
    const letScope = `let:${stmt.range.start.line}:${stmt.range.start.character}`;

    for (const binding of stmt.bindings) {
      this.symbolTable.addSymbol({
        name: binding.name.name,
        kind: "letBinding",
        location: { uri: this.uri, range: binding.name.range },
        scope: letScope,
      });
    }

    this.currentScope = letScope;
    for (const bodyStmt of stmt.body) {
      this.collectStatement(bodyStmt);
    }

    this.currentScope = previousScope;
  }

  private collectForeach(stmt: ForeachStatement): void {
    const previousScope = this.currentScope;
    const foreachScope = `foreach:${stmt.variable.range.start.line}:${stmt.variable.range.start.character}`;

    this.symbolTable.addSymbol({
      name: stmt.variable.name,
      kind: "foreachVar",
      location: { uri: this.uri, range: stmt.variable.range },
      scope: foreachScope,
    });

    this.collectExpression(stmt.iterRange);

    this.currentScope = foreachScope;
    for (const bodyStmt of stmt.body) {
      this.collectStatement(bodyStmt);
    }

    this.currentScope = previousScope;
  }

  private collectClassRef(ref: ClassRef): void {
    // Add reference to class name
    this.symbolTable.addReference({
      name: ref.name.name,
      location: { uri: this.uri, range: ref.name.range },
      scope: this.currentScope,
    });

    // Collect expressions in args
    for (const arg of ref.args) {
      this.collectExpression(arg);
    }
  }

  private collectExpression(expr: Expression): void {
    switch (expr.type) {
      case "Identifier":
        // This is a reference to something
        this.symbolTable.addReference({
          name: expr.name,
          location: { uri: this.uri, range: expr.range },
          scope: this.currentScope,
        });
        break;

      case "FieldAccess":
        this.collectExpression(expr.object);
        // Don't add field name as a reference - without type inference
        // we can't know which class's field it refers to, and adding it
        // would cause incorrect "Go to Definition" jumps
        break;

      case "ClassRef":
        this.collectClassRef(expr);
        break;

      case "ListExpr":
        for (const elem of expr.elements) {
          this.collectExpression(elem);
        }
        break;

      case "DagExpr":
        this.collectExpression(expr.operator);
        for (const arg of expr.args) {
          this.collectExpression(arg.value);
        }
        break;

      case "BangOperator":
        for (const arg of expr.args) {
          this.collectExpression(arg);
        }
        break;

      case "BinaryExpr":
        this.collectExpression(expr.left);
        this.collectExpression(expr.right);
        break;

      case "TernaryExpr":
        this.collectExpression(expr.condition);
        this.collectExpression(expr.thenExpr);
        this.collectExpression(expr.elseExpr);
        break;
    }
  }
}
