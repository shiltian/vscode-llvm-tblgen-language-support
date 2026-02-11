import assert from "node:assert/strict";
import test from "node:test";

import { parseTableGen } from "../server/parser";
import { SymbolCollector, SymbolTable } from "../server/symbols";
import { Symbol } from "../server/types";

function collectSymbols(
  text: string,
  uri = "file:///symbols_test.td",
): SymbolTable {
  const parsed = parseTableGen(text, uri);
  const table = new SymbolTable();
  const collector = new SymbolCollector(table, uri);
  collector.collect(parsed);
  return table;
}

function makeSymbol(
  name: string,
  uri: string,
  isForwardDeclaration = false,
): Symbol {
  return {
    name,
    kind: "class",
    location: {
      uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
    },
    isForwardDeclaration,
  };
}

test("collects global and scoped symbols across class and def scopes", () => {
  const table = collectSymbols(`
class Base;
class C<int N> : Base {
  int F = N;
  defvar V = N;
}
def R : C<N>;
`);

  const classDef = table.findDefinition("C");
  assert.ok(classDef);
  assert.equal(classDef.kind, "class");

  const recordDef = table.findDefinition("R");
  assert.ok(recordDef);
  assert.equal(recordDef.kind, "def");

  const templateArg = table.findDefinition("N", "class:C");
  assert.ok(templateArg);
  assert.equal(templateArg.kind, "templateArg");

  const field = table.findDefinition("F", "class:C");
  assert.ok(field);
  assert.equal(field.kind, "field");

  const defvar = table.findDefinition("V", "class:C");
  assert.ok(defvar);
  assert.equal(defvar.kind, "defvar");

  assert.equal(table.findReferences("Base").length, 1);
  assert.ok(table.findReferences("N").length >= 2);
});

test("field access adds reference for object but not field name", () => {
  const table = collectSymbols(`
defvar P = Obj.Field;
`);

  assert.equal(table.findReferences("Obj").length, 1);
  assert.equal(table.findReferences("Field").length, 0);
});

test("let and foreach define scoped symbols", () => {
  const table = collectSymbols(`
let X = 1 in {
  defvar A = X;
}
foreach I = [1, 2] in {
  defvar B = I;
}
`);

  const xDefs = table.findAllDefinitions("X");
  assert.ok(xDefs.some((d) => d.kind === "letBinding"));

  const iDefs = table.findAllDefinitions("I");
  assert.ok(iDefs.some((d) => d.kind === "foreachVar"));
});

test("clearFile removes only symbols and references from that file", () => {
  const table = new SymbolTable();
  const uriA = "file:///a.td";
  const uriB = "file:///b.td";

  table.addSymbol(makeSymbol("Foo", uriA));
  table.addSymbol(makeSymbol("Foo", uriB));
  table.addReference({
    name: "Foo",
    location: {
      uri: uriA,
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 3 },
      },
    },
  });

  assert.equal(table.findAllDefinitions("Foo").length, 2);
  assert.equal(table.findReferences("Foo").length, 1);

  table.clearFile(uriA);

  const defsAfter = table.findAllDefinitions("Foo");
  assert.equal(defsAfter.length, 1);
  assert.equal(defsAfter[0].location.uri, uriB);
  assert.equal(table.findReferences("Foo").length, 0);
});

test("findDefinition prefers non-forward declaration", () => {
  const table = new SymbolTable();
  const uri = "file:///forward.td";

  table.addSymbol(makeSymbol("Foo", uri, true));
  table.addSymbol(makeSymbol("Foo", uri, false));

  const def = table.findDefinition("Foo");
  assert.ok(def);
  assert.equal(def.isForwardDeclaration, false);
});

test("getSymbolAtPosition prefers references over symbols", () => {
  const table = new SymbolTable();
  const uri = "file:///position.td";
  const range = {
    start: { line: 2, character: 1 },
    end: { line: 2, character: 4 },
  };

  table.addSymbol({
    name: "Sym",
    kind: "def",
    location: { uri, range },
  });
  table.addReference({
    name: "Ref",
    location: { uri, range },
  });

  const atPos = table.getSymbolAtPosition(uri, 2, 2);
  assert.ok(atPos);
  assert.equal(atPos.name, "Ref");
});
