import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTableGen } from '../server/parser';
import {
    computeCompositeDefmSymbols,
    findDefvarInStatements,
    inferTypeFromExpression,
    normalizeCastTypeName,
} from '../server/resolutionHelpers';
import { MultiClassDef, ParsedFile } from '../server/types';

function buildMulticlassFinder(parsed: ParsedFile) {
    const map = new Map<string, MultiClassDef>();
    for (const stmt of parsed.statements) {
        if (stmt.type === 'MultiClassDef') {
            map.set(stmt.name.name, stmt);
        }
    }
    return (name: string) => map.get(name);
}

test('normalizeCastTypeName handles simple and templated cast types', () => {
    assert.equal(normalizeCastTypeName('Foo'), 'Foo');
    assert.equal(normalizeCastTypeName(' Foo<Bar<Baz>> '), 'Foo');
    assert.equal(normalizeCastTypeName('_Internal42<T>'), '_Internal42');
    assert.equal(normalizeCastTypeName('   '), undefined);
    assert.equal(normalizeCastTypeName('123bad'), 'bad');
    assert.equal(normalizeCastTypeName('@@@'), undefined);
});

test('inferTypeFromExpression resolves !cast when class exists', () => {
    const parsed = parseTableGen(
        'defvar P = !cast<VOP3PWMMA_Profile>(ProfileName);',
        'file:///cast_test.td'
    );
    const defvar = parsed.statements[0];
    assert.equal(defvar.type, 'DefvarDef');

    const inferred = inferTypeFromExpression(
        defvar.value,
        (className: string) => className === 'VOP3PWMMA_Profile'
    );
    assert.deepEqual(inferred, { kind: 'class', name: 'VOP3PWMMA_Profile' });

    const missing = inferTypeFromExpression(defvar.value, () => false);
    assert.equal(missing, undefined);
});

test('findDefvarInStatements finds nested defvar and supports range disambiguation', () => {
    const parsed = parseTableGen(`
defvar P = !cast<Foo>(Top);
let A = 0 in {
  defvar P = !cast<Bar>(Inner);
}
`, 'file:///defvar_lookup.td');

    const top = parsed.statements[0];
    assert.equal(top.type, 'DefvarDef');
    const letStmt = parsed.statements[1];
    assert.equal(letStmt.type, 'LetStatement');
    const nested = letStmt.body[0];
    assert.equal(nested.type, 'DefvarDef');

    const byNameOnly = findDefvarInStatements(parsed.statements, 'P');
    assert.ok(byNameOnly);
    assert.equal(byNameOnly.name.range.start.line, top.name.range.start.line);

    const byRange = findDefvarInStatements(parsed.statements, 'P', nested.name.range);
    assert.ok(byRange);
    assert.equal(byRange.name.range.start.line, nested.name.range.start.line);
});

test('computeCompositeDefmSymbols builds symbols from inherited multiclass defs', () => {
    const parsed = parseTableGen(`
multiclass A {
  def _a : Base;
}

multiclass B : A {
  def _b : Base;
}

defm Z : B;
`, 'file:///composite_inherited.td');

    const findMulticlass = buildMulticlassFinder(parsed);
    const symbols = computeCompositeDefmSymbols(parsed.statements, parsed.uri, findMulticlass);
    const names = symbols.map(s => s.name);

    assert.deepEqual(names, ['Z_a', 'Z_b']);
    assert.ok(symbols.every(s => s.kind === 'def'));
});

test('computeCompositeDefmSymbols handles nested defm in multiclass bodies', () => {
    const parsed = parseTableGen(`
multiclass A {
  def _x : Base;
}
multiclass B {
  defm _n : A;
}
defm Z : B;
`, 'file:///composite_nested.td');

    const findMulticlass = buildMulticlassFinder(parsed);
    const symbols = computeCompositeDefmSymbols(parsed.statements, parsed.uri, findMulticlass);
    const names = symbols.map(s => s.name);
    assert.deepEqual(names, ['Z_n_x']);
});

test('computeCompositeDefmSymbols traverses defm in let/foreach/if bodies', () => {
    const parsed = parseTableGen(`
multiclass A {
  def _x : Base;
}
let L = 1 in {
  defm LDef : A;
}
foreach I = [1] in {
  defm FDef : A;
}
if Cond then {
  defm TDef : A;
} else {
  defm EDef : A;
}
`, 'file:///composite_nested_statements.td');

    const findMulticlass = buildMulticlassFinder(parsed);
    const symbols = computeCompositeDefmSymbols(parsed.statements, parsed.uri, findMulticlass);
    const names = symbols.map(s => s.name);

    assert.deepEqual(names, ['LDef_x', 'FDef_x', 'TDef_x', 'EDef_x']);
});

test('computeCompositeDefmSymbols is cycle-safe for recursive multiclass inheritance', () => {
    const parsed = parseTableGen(`
multiclass A : B {
  def _a : Base;
}
multiclass B : A {
  def _b : Base;
}
defm Z : A;
`, 'file:///composite_cycle.td');

    const findMulticlass = buildMulticlassFinder(parsed);
    const symbols = computeCompositeDefmSymbols(parsed.statements, parsed.uri, findMulticlass);
    const names = symbols.map(s => s.name);

    // Cycle is cut by visiting-guard; both local suffixes are still collected.
    assert.deepEqual(names, ['Z_a', 'Z_b']);
});
