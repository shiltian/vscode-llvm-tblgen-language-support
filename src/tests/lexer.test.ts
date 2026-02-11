import assert from "node:assert/strict";
import test from "node:test";

import { Lexer } from "../server/parser";

function tokenize(text: string) {
  const lexer = new Lexer(text, "file:///lexer_test.td");
  return lexer.tokenize();
}

test("tokenizes decimal, hex, binary, and negative numbers", () => {
  const tokens = tokenize("1 -42 0x1A 0b101");
  const numbers = tokens.filter((t) => t.type === "number").map((t) => t.value);
  assert.deepEqual(numbers, ["1", "-42", "0x1A", "0b101"]);
});

test("tokenizes bang operator and punctuation used by templates", () => {
  const tokens = tokenize("!cast<Foo<Bar>>(X)");
  const values = tokens.map((t) => t.value);

  assert.ok(values.includes("!cast"));
  assert.ok(values.includes("<"));
  assert.ok(values.includes(">"));
  assert.ok(values.includes("("));
  assert.ok(values.includes(")"));
});

test("skips line and block comments", () => {
  const tokens = tokenize(`
// line comment
class A /* block */ {
  int X;
}
`);
  const values = tokens.map((t) => t.value);
  assert.ok(values.includes("class"));
  assert.ok(values.includes("A"));
  assert.ok(values.includes("int"));
  assert.ok(!values.includes("line"));
  assert.ok(!values.includes("block"));
});

test("tokenizes string and code block literals", () => {
  const tokens = tokenize('"hello" [{ code body }]');
  const stringToken = tokens.find((t) => t.type === "string");
  const codeToken = tokens.find((t) => t.type === "code");
  assert.ok(stringToken);
  assert.equal(stringToken.value, "hello");
  assert.ok(codeToken);
  assert.equal(codeToken.value.trim(), "code body");
});
