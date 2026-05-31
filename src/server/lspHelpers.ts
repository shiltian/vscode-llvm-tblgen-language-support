import {
  Diagnostic,
  DiagnosticSeverity,
  InitializeResult,
  Range as LSPRange,
  TextEdit,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";

import { ParseError, Symbol, SymbolReference } from "./types";

export function buildInitializeResult(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      documentSymbolProvider: true,
      hoverProvider: false,
    },
  };
}

export function parseErrorsToDiagnostics(errors: ParseError[]): Diagnostic[] {
  return errors.map((error) => ({
    severity: DiagnosticSeverity.Error,
    range: error.range,
    message: error.message,
    source: "tablegen",
  }));
}

export function addDeduplicatedTextEdit(
  changes: { [uri: string]: TextEdit[] },
  uri: string,
  range: LSPRange,
  newText: string,
): void {
  if (!changes[uri]) {
    changes[uri] = [];
  }

  const key = rangeKey(range, newText);
  if (changes[uri].some((edit) => rangeKey(edit.range, edit.newText) === key)) {
    return;
  }

  changes[uri].push({ range, newText });
}

export function shouldIncludeRenameSymbol(
  symbol: Symbol,
  activeScope: string | undefined,
  visibleUris: Set<string>,
): boolean {
  if (!visibleUris.has(symbol.location.uri)) {
    return false;
  }

  if (symbol.isSynthetic) {
    return false;
  }

  return shouldIncludeScope(symbol.scope, activeScope);
}

export function shouldIncludeRenameReference(
  ref: SymbolReference,
  activeScope: string | undefined,
  visibleUris: Set<string>,
): boolean {
  if (!visibleUris.has(ref.location.uri)) {
    return false;
  }

  return shouldIncludeScope(ref.scope, activeScope);
}

function shouldIncludeScope(
  candidateScope: string | undefined,
  activeScope: string | undefined,
): boolean {
  // Global symbols are often referenced from nested scopes, so keep the broad
  // behavior for global renames. Scoped local variables are narrowed.
  if (!activeScope) {
    return candidateScope === undefined;
  }

  return candidateScope === activeScope;
}

function rangeKey(range: LSPRange, newText: string): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}:${newText}`;
}
