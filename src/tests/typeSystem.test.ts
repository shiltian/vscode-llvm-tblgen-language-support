import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTableGen } from '../server/parser';
import {
    ClassInfo,
    FieldInfo,
    TypeCollector,
    TypeSystem,
    parseTypeString,
} from '../server/typeSystem';

function field(
    name: string,
    uri: string,
    line: number,
    typeName = 'int'
): FieldInfo {
    return {
        name,
        type: parseTypeString(typeName),
        location: {
            uri,
            range: {
                start: { line, character: 0 },
                end: { line, character: name.length },
            },
        },
        declaringClass: '',
    };
}

function addClass(typeSystem: TypeSystem, info: ClassInfo): void {
    typeSystem.addClass(info);
}

test('parseTypeString handles builtin, bits, list, and class types', () => {
    assert.deepEqual(parseTypeString('int'), { kind: 'builtin', name: 'int' });
    assert.deepEqual(parseTypeString('bits<32>'), { kind: 'bits', name: 'bits', bitWidth: 32 });
    assert.deepEqual(parseTypeString('list<int>'), {
        kind: 'list',
        name: 'list',
        elementType: { kind: 'builtin', name: 'int' },
    });
    assert.deepEqual(parseTypeString('MyClass'), { kind: 'class', name: 'MyClass' });
});

test('getAllFields merges parent fields and child overrides parent', () => {
    const typeSystem = new TypeSystem();
    const uri = 'file:///fields.td';

    const baseFields = new Map<string, FieldInfo>();
    baseFields.set('X', field('X', uri, 1));
    baseFields.set('Y', field('Y', uri, 2));

    const childFields = new Map<string, FieldInfo>();
    childFields.set('X', field('X', uri, 10)); // override
    childFields.set('Z', field('Z', uri, 11));

    addClass(typeSystem, {
        name: 'Base',
        kind: 'class',
        location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } },
        uri,
        parentClasses: [],
        arguments: [],
        fields: baseFields,
        isForwardDeclaration: false,
    });

    addClass(typeSystem, {
        name: 'Child',
        kind: 'class',
        location: { uri, range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } } },
        uri,
        parentClasses: ['Base'],
        arguments: [],
        fields: childFields,
        isForwardDeclaration: false,
    });

    const all = typeSystem.getAllFields('Child');
    assert.equal(all.size, 3);
    assert.equal(all.get('X')?.location.range.start.line, 10);
    assert.equal(all.get('Y')?.location.range.start.line, 2);
    assert.equal(all.get('Z')?.location.range.start.line, 11);
});

test('findFieldDefinition follows parent order for conflicts', () => {
    const typeSystem = new TypeSystem();
    const uri = 'file:///parents.td';

    const fieldsA = new Map<string, FieldInfo>([['F', field('F', uri, 1)]]);
    const fieldsB = new Map<string, FieldInfo>([['F', field('F', uri, 2)]]);

    addClass(typeSystem, {
        name: 'A',
        kind: 'class',
        location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        uri,
        parentClasses: [],
        arguments: [],
        fields: fieldsA,
        isForwardDeclaration: false,
    });
    addClass(typeSystem, {
        name: 'B',
        kind: 'class',
        location: { uri, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } } },
        uri,
        parentClasses: [],
        arguments: [],
        fields: fieldsB,
        isForwardDeclaration: false,
    });
    addClass(typeSystem, {
        name: 'C',
        kind: 'class',
        location: { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } } },
        uri,
        parentClasses: ['A', 'B'],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: false,
    });

    const def = typeSystem.findFieldDefinition('C', 'F');
    assert.ok(def);
    assert.equal(def.location.range.start.line, 1);
});

test('getAllParentClasses returns direct and transitive parents without duplicates', () => {
    const typeSystem = new TypeSystem();
    const uri = 'file:///parents2.td';

    addClass(typeSystem, {
        name: 'A',
        kind: 'class',
        location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        uri,
        parentClasses: [],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: false,
    });
    addClass(typeSystem, {
        name: 'B',
        kind: 'class',
        location: { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
        uri,
        parentClasses: ['A'],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: false,
    });
    addClass(typeSystem, {
        name: 'C',
        kind: 'class',
        location: { uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
        uri,
        parentClasses: ['A', 'B'],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: false,
    });

    const parents = typeSystem.getAllParentClasses('C');
    assert.deepEqual(parents, ['A', 'B']);
});

test('addClass prefers full definition over forward declaration', () => {
    const typeSystem = new TypeSystem();
    const uri = 'file:///forward.td';

    addClass(typeSystem, {
        name: 'Foo',
        kind: 'class',
        location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        uri,
        parentClasses: [],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: true,
    });

    addClass(typeSystem, {
        name: 'Foo',
        kind: 'class',
        location: { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
        uri,
        parentClasses: [],
        arguments: [],
        fields: new Map([['X', field('X', uri, 2)]]),
        isForwardDeclaration: false,
    });

    addClass(typeSystem, {
        name: 'Foo',
        kind: 'class',
        location: { uri, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 3 } } },
        uri,
        parentClasses: [],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: true,
    });

    const cls = typeSystem.getClass('Foo');
    assert.ok(cls);
    assert.equal(cls.isForwardDeclaration, false);
    assert.ok(cls.fields.has('X'));
});

test('TypeCollector collects nested definitions from let/foreach/if and defm', () => {
    const uri = 'file:///collector.td';
    const parsed = parseTableGen(`
class Base {
  int F;
}
let X = 1 in {
  def InLet : Base;
}
foreach I = [1] in {
  def InFor : Base;
}
if Cond then {
  def InThen : Base;
} else {
  def InElse : Base;
}
defm M : SomeMC;
`, uri);

    const typeSystem = new TypeSystem();
    const collector = new TypeCollector(typeSystem, uri);
    collector.collect(parsed);

    assert.ok(typeSystem.getClass('Base'));
    assert.ok(typeSystem.getClass('InLet'));
    assert.ok(typeSystem.getClass('InFor'));
    assert.ok(typeSystem.getClass('InThen'));
    assert.ok(typeSystem.getClass('InElse'));

    const defm = typeSystem.getClass('M');
    assert.ok(defm);
    assert.equal(defm.kind, 'defm');
    assert.equal(defm.parentClasses.length, 1);
    assert.equal(defm.parentClasses[0], 'SomeMC');
});

test('clearFile removes classes from that uri', () => {
    const typeSystem = new TypeSystem();

    addClass(typeSystem, {
        name: 'A',
        kind: 'class',
        location: {
            uri: 'file:///a.td',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        uri: 'file:///a.td',
        parentClasses: [],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: false,
    });

    addClass(typeSystem, {
        name: 'B',
        kind: 'class',
        location: {
            uri: 'file:///b.td',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
        uri: 'file:///b.td',
        parentClasses: [],
        arguments: [],
        fields: new Map(),
        isForwardDeclaration: false,
    });

    typeSystem.clearFile('file:///a.td');
    assert.equal(typeSystem.getClass('A'), undefined);
    assert.ok(typeSystem.getClass('B'));
});
