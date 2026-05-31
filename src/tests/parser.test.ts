import assert from "node:assert/strict";
import test from "node:test";

import { parseTableGen } from "../server/parser";

function parse(text: string) {
  return parseTableGen(text, "file:///parser_test.td");
}

test("parses class forward declaration and class definition", () => {
  const parsed = parse(`
class Foo;
class Bar<int N = 4> : Foo {
  int Value = N;
}
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 2);

  const foo = parsed.statements[0];
  assert.equal(foo.type, "ClassDef");
  assert.equal(foo.name.name, "Foo");
  assert.equal(foo.isForwardDeclaration, true);

  const bar = parsed.statements[1];
  assert.equal(bar.type, "ClassDef");
  assert.equal(bar.name.name, "Bar");
  assert.equal(bar.isForwardDeclaration, false);
  assert.equal(bar.templateArgs.length, 1);
  assert.equal(bar.templateArgs[0].name.name, "N");
  assert.ok(bar.templateArgs[0].defaultValue);
  assert.equal(bar.parentClasses.length, 1);
  assert.equal(bar.parentClasses[0].name.name, "Foo");
});

test("parses named and anonymous defm", () => {
  const parsed = parse(`
defm Named : M1, M2;
defm : M3;
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 2);

  const named = parsed.statements[0];
  assert.equal(named.type, "DefmDef");
  assert.ok(named.name);
  assert.equal(named.name.name, "Named");
  assert.equal(named.parentClasses.length, 2);
  assert.equal(named.parentClasses[0].name.name, "M1");
  assert.equal(named.parentClasses[1].name.name, "M2");

  const anonymous = parsed.statements[1];
  assert.equal(anonymous.type, "DefmDef");
  assert.equal(anonymous.name, null);
  assert.equal(anonymous.parentClasses.length, 1);
  assert.equal(anonymous.parentClasses[0].name.name, "M3");
});

test("parses defset with nested generic value type", () => {
  const parsed = parse(`
defset list<Foo<Bar>> MySet = {
  def X : Base;
}
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 1);

  const defset = parsed.statements[0];
  assert.equal(defset.type, "DefsetDef");
  assert.equal(defset.valueType, "list<Foo<Bar>>");
  assert.equal(defset.name.name, "MySet");
  assert.equal(defset.body.length, 1);
  assert.equal(defset.body[0].type, "RecordDef");
});

test("parses !cast type argument text including nested angle brackets", () => {
  const parsed = parse(`
defvar P0 = !cast<VOP3PWMMA_Profile>(ProfileName);
defvar P1 = !cast<Foo<Bar<Baz>>>(X);
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 2);

  const p0 = parsed.statements[0];
  assert.equal(p0.type, "DefvarDef");
  assert.equal(p0.value.type, "BangOperator");
  assert.equal(p0.value.operator, "!cast");
  assert.equal(p0.value.typeArgText, "VOP3PWMMA_Profile");

  const p1 = parsed.statements[1];
  assert.equal(p1.type, "DefvarDef");
  assert.equal(p1.value.type, "BangOperator");
  assert.equal(p1.value.operator, "!cast");
  assert.equal(p1.value.typeArgText, "Foo<Bar<Baz>>");
});

test("parses let/foreach/if bodies with single statement and braces", () => {
  const parsed = parse(`
let A = 1, B = 2 in def R : Base;
foreach I = [1,2] in {
  if I then def T : Base;
}
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 2);

  const letStmt = parsed.statements[0];
  assert.equal(letStmt.type, "LetStatement");
  assert.equal(letStmt.bindings.length, 2);
  assert.equal(letStmt.body.length, 1);
  assert.equal(letStmt.body[0].type, "RecordDef");

  const foreachStmt = parsed.statements[1];
  assert.equal(foreachStmt.type, "ForeachStatement");
  assert.equal(foreachStmt.variable.name, "I");
  assert.equal(foreachStmt.body.length, 1);
  assert.equal(foreachStmt.body[0].type, "IfStatement");
  const ifStmt = foreachStmt.body[0];
  assert.equal(ifStmt.type, "IfStatement");
  assert.equal(ifStmt.thenBody.length, 1);
  assert.equal(ifStmt.thenBody[0].type, "RecordDef");
});

test("parses include and assert statements", () => {
  const parsed = parse(`
include "path/to/file.td"
assert Cond, "oops";
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 2);

  const includeStmt = parsed.statements[0];
  assert.equal(includeStmt.type, "IncludeStatement");
  assert.equal(includeStmt.path, "path/to/file.td");

  const assertStmt = parsed.statements[1];
  assert.equal(assertStmt.type, "AssertStatement");
  assert.equal(assertStmt.condition.type, "Identifier");
  assert.equal(assertStmt.condition.name, "Cond");
  assert.equal(assertStmt.message.type, "StringLiteral");
  assert.equal(assertStmt.message.value, "oops");
});

test("parses field definitions with complex field types", () => {
  const parsed = parse(`
class C {
  bits<32> Mask;
  list<int> Values;
  dag Pattern;
}
`);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 1);

  const cls = parsed.statements[0];
  assert.equal(cls.type, "ClassDef");
  assert.equal(cls.body.length, 3);
  assert.equal(cls.body[0].type, "FieldDef");
  assert.equal(cls.body[0].fieldType, "bits<32>");
  assert.equal(cls.body[0].name.name, "Mask");
  assert.equal(cls.body[1].type, "FieldDef");
  assert.equal(cls.body[1].fieldType, "list<int>");
  assert.equal(cls.body[1].name.name, "Values");
  assert.equal(cls.body[2].type, "FieldDef");
  assert.equal(cls.body[2].fieldType, "dag");
  assert.equal(cls.body[2].name.name, "Pattern");
});

test("parses DAG dollar operands and named DAG arguments", () => {
  const parsed = parse(`
def P : Pat<(op GPR:$src, $dst), []>;
`);

  assert.equal(parsed.errors.length, 0);
  const def = parsed.statements[0];
  assert.equal(def.type, "RecordDef");
  const pat = def.parentClasses[0];
  const dag = pat.args[0];
  assert.equal(dag.type, "DagExpr");
  assert.equal(dag.args.length, 2);
  assert.equal(dag.args[0].value.type, "Identifier");
  assert.equal(dag.args[0].value.name, "GPR");
  assert.equal(dag.args[0].name?.name, "$src");
  assert.equal(dag.args[1].value.type, "Identifier");
  assert.equal(dag.args[1].value.name, "$dst");
});

test("parses paste operator names without corrupting parent classes", () => {
  const parsed = parse("def X#Y : Base;");

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 1);
  const def = parsed.statements[0];
  assert.equal(def.type, "RecordDef");
  assert.equal(def.name?.name, "X#Y");
  assert.equal(def.parentClasses.length, 1);
  assert.equal(def.parentClasses[0].name.name, "Base");
});

test("parses symbolic bits template argument types", () => {
  const parsed = parse("class C<bits<N> mask>;");

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.statements.length, 1);
  const cls = parsed.statements[0];
  assert.equal(cls.type, "ClassDef");
  assert.equal(cls.templateArgs.length, 1);
  assert.equal(cls.templateArgs[0].argType, "bits<N>");
  assert.equal(cls.templateArgs[0].name.name, "mask");
});

test("parses chained field access", () => {
  const parsed = parse("defvar X = A.B.C;");

  assert.equal(parsed.errors.length, 0);
  const defvar = parsed.statements[0];
  assert.equal(defvar.type, "DefvarDef");
  assert.equal(defvar.value.type, "FieldAccess");
  assert.equal(defvar.value.field.name, "C");
  assert.equal(defvar.value.object.type, "FieldAccess");
  assert.equal(defvar.value.object.field.name, "B");
});

test("preserves raw spelling for large integer literals", () => {
  const parsed = parse("defvar Big = 0xFFFFFFFFFFFFFFFF;");

  assert.equal(parsed.errors.length, 0);
  const defvar = parsed.statements[0];
  assert.equal(defvar.type, "DefvarDef");
  assert.equal(defvar.value.type, "NumberLiteral");
  assert.equal(defvar.value.rawValue, "0xFFFFFFFFFFFFFFFF");
});

test("reports parse errors for missing identifiers", () => {
  const parsed = parse("class {");

  assert.ok(
    parsed.errors.some((error) =>
      error.message.includes("Expected identifier"),
    ),
  );
});
