// AST Node Types for TableGen

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Location {
    uri: string;
    range: Range;
}

// Base AST node
export interface ASTNode {
    type: string;
    range: Range;
}

// Identifier with location info
export interface Identifier extends ASTNode {
    type: 'Identifier';
    name: string;
}

// Template argument: <type name, type name, ...>
export interface TemplateArg extends ASTNode {
    type: 'TemplateArg';
    argType: string;
    name: Identifier;
    defaultValue?: Expression;
}

// Class definition or forward declaration
export interface ClassDef extends ASTNode {
    type: 'ClassDef';
    name: Identifier;
    templateArgs: TemplateArg[];
    parentClasses: ClassRef[];
    body: Statement[];
    isForwardDeclaration: boolean; // true for "class Foo;" without body
}

// Class reference (with optional template args)
export interface ClassRef extends ASTNode {
    type: 'ClassRef';
    name: Identifier;
    args: Expression[];
}

// Record definition (def)
export interface RecordDef extends ASTNode {
    type: 'RecordDef';
    name: Identifier | null; // null for anonymous defs
    parentClasses: ClassRef[];
    body: Statement[];
}

// Multiclass definition
export interface MultiClassDef extends ASTNode {
    type: 'MultiClassDef';
    name: Identifier;
    templateArgs: TemplateArg[];
    parentClasses: ClassRef[];
    body: Statement[];
}

// Defm statement
export interface DefmDef extends ASTNode {
    type: 'DefmDef';
    name: Identifier | null;
    parentClasses: ClassRef[];
}

// Defset statement
export interface DefsetDef extends ASTNode {
    type: 'DefsetDef';
    valueType: string;
    name: Identifier;
    body: Statement[];
}

// Defvar statement
export interface DefvarDef extends ASTNode {
    type: 'DefvarDef';
    name: Identifier;
    value: Expression;
}

// Field definition
export interface FieldDef extends ASTNode {
    type: 'FieldDef';
    fieldType: string;
    name: Identifier;
    value?: Expression;
}

// Let statement
export interface LetStatement extends ASTNode {
    type: 'LetStatement';
    bindings: LetBinding[];
    body: Statement[];
}

export interface LetBinding extends ASTNode {
    type: 'LetBinding';
    name: Identifier;
    value: Expression;
}

// Foreach statement
export interface ForeachStatement extends ASTNode {
    type: 'ForeachStatement';
    variable: Identifier;
    iterRange: Expression;
    body: Statement[];
}

// If statement
export interface IfStatement extends ASTNode {
    type: 'IfStatement';
    condition: Expression;
    thenBody: Statement[];
    elseBody: Statement[];
}

// Include statement
export interface IncludeStatement extends ASTNode {
    type: 'IncludeStatement';
    path: string;
}

// Assert statement
export interface AssertStatement extends ASTNode {
    type: 'AssertStatement';
    condition: Expression;
    message: Expression;
}

// Expression types
export type Expression =
    | Identifier
    | NumberLiteral
    | StringLiteral
    | CodeLiteral
    | ListExpr
    | DagExpr
    | BangOperator
    | BinaryExpr
    | TernaryExpr
    | FieldAccess
    | ClassRef;

export interface NumberLiteral extends ASTNode {
    type: 'NumberLiteral';
    value: number;
}

export interface StringLiteral extends ASTNode {
    type: 'StringLiteral';
    value: string;
}

export interface CodeLiteral extends ASTNode {
    type: 'CodeLiteral';
    value: string;
}

export interface ListExpr extends ASTNode {
    type: 'ListExpr';
    elements: Expression[];
}

export interface DagExpr extends ASTNode {
    type: 'DagExpr';
    operator: Expression;
    args: DagArg[];
}

export interface DagArg extends ASTNode {
    type: 'DagArg';
    value: Expression;
    name?: Identifier;
}

export interface BangOperator extends ASTNode {
    type: 'BangOperator';
    operator: string;
    args: Expression[];
}

export interface BinaryExpr extends ASTNode {
    type: 'BinaryExpr';
    operator: string;
    left: Expression;
    right: Expression;
}

export interface TernaryExpr extends ASTNode {
    type: 'TernaryExpr';
    condition: Expression;
    thenExpr: Expression;
    elseExpr: Expression;
}

export interface FieldAccess extends ASTNode {
    type: 'FieldAccess';
    object: Expression;
    field: Identifier;
}

// Top-level statement types
export type Statement =
    | ClassDef
    | RecordDef
    | MultiClassDef
    | DefmDef
    | DefsetDef
    | DefvarDef
    | FieldDef
    | LetStatement
    | ForeachStatement
    | IfStatement
    | IncludeStatement
    | AssertStatement;

// Parsed file
export interface ParsedFile {
    uri: string;
    statements: Statement[];
    includes: IncludeStatement[];
    errors: ParseError[];
}

export interface ParseError {
    message: string;
    range: Range;
}

// Symbol types
export type SymbolKind =
    | 'class'
    | 'def'
    | 'defm'
    | 'multiclass'
    | 'defset'
    | 'defvar'
    | 'field'
    | 'templateArg'
    | 'foreachVar'
    | 'letBinding';

export interface Symbol {
    name: string;
    kind: SymbolKind;
    location: Location;
    scope?: string; // For scoped symbols, the containing scope identifier
    isForwardDeclaration?: boolean; // For class forward declarations
}

export interface SymbolReference {
    name: string;
    location: Location;
    scope?: string; // The scope this reference is in
    definitionLocation?: Location;
}

