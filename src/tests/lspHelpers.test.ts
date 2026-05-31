import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { TextDocumentSyncKind } from "vscode-languageserver/node";

import {
  addDeduplicatedTextEdit,
  buildInitializeResult,
  parseErrorsToDiagnostics,
  shouldIncludeDocumentSymbol,
  shouldIncludeRenameSymbol,
} from "../server/lspHelpers";
import { filePathToUri, uriToFilePath } from "../server/pathUtils";
import { Symbol } from "../server/types";

const range = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 5 },
};

test("parse errors become LSP diagnostics", () => {
  const diagnostics = parseErrorsToDiagnostics([
    {
      message: "Expected identifier",
      range,
    },
  ]);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, "Expected identifier");
  assert.equal(diagnostics[0].source, "tablegen");
  assert.deepEqual(parseErrorsToDiagnostics([]), []);
});

test("initialize capabilities only advertise implemented features", () => {
  const result = buildInitializeResult();

  assert.equal(
    result.capabilities.textDocumentSync,
    TextDocumentSyncKind.Incremental,
  );
  assert.equal(result.capabilities.definitionProvider, true);
  assert.equal(result.capabilities.hoverProvider, false);
});

test("file URI helpers round-trip encoded paths", () => {
  const filePath = path.join("/tmp", "tablegen path #1", "File.td");
  const uri = filePathToUri(filePath);

  assert.ok(uri.includes("tablegen%20path%20%231"));
  assert.equal(uriToFilePath(uri), filePath);
});

test("rename helpers deduplicate edits and skip synthetic symbols", () => {
  const changes: { [uri: string]: { range: typeof range; newText: string }[] } =
    {};
  const uri = "file:///rename.td";

  addDeduplicatedTextEdit(changes, uri, range, "New");
  addDeduplicatedTextEdit(changes, uri, range, "New");
  assert.equal(changes[uri].length, 1);

  const syntheticSymbol: Symbol = {
    name: "Generated",
    kind: "def",
    location: { uri, range },
    isSynthetic: true,
  };
  assert.equal(
    shouldIncludeRenameSymbol(syntheticSymbol, undefined, new Set([uri])),
    false,
  );
});

test("rename helper narrows scoped symbols", () => {
  const uri = "file:///rename-scoped.td";
  const localSymbol: Symbol = {
    name: "X",
    kind: "letBinding",
    location: { uri, range },
    scope: "let:1:0",
  };
  const otherLocalSymbol: Symbol = {
    name: "X",
    kind: "foreachVar",
    location: { uri, range },
    scope: "foreach:4:0",
  };
  const visibleUris = new Set([uri]);

  assert.equal(
    shouldIncludeRenameSymbol(localSymbol, "let:1:0", visibleUris),
    true,
  );
  assert.equal(
    shouldIncludeRenameSymbol(otherLocalSymbol, "let:1:0", visibleUris),
    false,
  );
});

test("document symbol helper keeps only real top-level declarations", () => {
  const uri = "file:///outline.td";
  const make = (
    name: string,
    kind: Symbol["kind"],
    scope?: string,
  ): Symbol => ({
    name,
    kind,
    location: { uri, range },
    scope,
  });

  assert.equal(shouldIncludeDocumentSymbol(make("C", "class")), true);
  assert.equal(shouldIncludeDocumentSymbol(make("D", "def")), true);
  assert.equal(
    shouldIncludeDocumentSymbol(make("InnerField", "field", "class:C")),
    false,
  );
  assert.equal(shouldIncludeDocumentSymbol(make("Flag", "letBinding")), false);
});
