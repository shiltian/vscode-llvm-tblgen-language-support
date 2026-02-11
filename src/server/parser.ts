import {
    Range,
    Position,
    Identifier,
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
    IfStatement,
    IncludeStatement,
    AssertStatement,
    TemplateArg,
    ClassRef,
    Expression,
    ParsedFile,
    ParseError,
    LetBinding,
} from './types';

// Token types
type TokenType =
    | 'keyword'
    | 'identifier'
    | 'number'
    | 'string'
    | 'code'
    | 'operator'
    | 'punctuation'
    | 'comment'
    | 'eof';

interface Token {
    type: TokenType;
    value: string;
    range: Range;
}

// Keywords
const KEYWORDS = new Set([
    'class', 'def', 'defm', 'defset', 'defvar', 'multiclass',
    'let', 'in', 'foreach', 'if', 'then', 'else',
    'include', 'field', 'bit', 'bits', 'int', 'string',
    'list', 'dag', 'code', 'assert'
]);

// Bang operators
const BANG_OPERATORS = new Set([
    'if', 'cond', 'cast', 'isa', 'exists', 'foreach', 'filter', 'foldl',
    'head', 'tail', 'size', 'empty', 'listconcat', 'listsplat', 'listremove',
    'range', 'strconcat', 'interleave', 'substr', 'find', 'tolower', 'toupper',
    'concat', 'add', 'sub', 'mul', 'div', 'not', 'and', 'or', 'xor',
    'sra', 'srl', 'shl', 'eq', 'ne', 'lt', 'le', 'gt', 'ge',
    'setdagop', 'getdagop', 'getdagarg', 'getdagname', 'setdagarg', 'setdagname',
    'dag', 'repr'
]);

export class Lexer {
    private text: string;
    private pos: number = 0;
    private line: number = 0;
    private character: number = 0;
    private uri: string;

    constructor(text: string, uri: string) {
        this.text = text;
        this.uri = uri;
    }

    private currentPos(): Position {
        return { line: this.line, character: this.character };
    }

    private peek(offset: number = 0): string {
        return this.text[this.pos + offset] || '';
    }

    private advance(): string {
        const ch = this.text[this.pos++];
        if (ch === '\n') {
            this.line++;
            this.character = 0;
        } else {
            this.character++;
        }
        return ch;
    }

    private skipWhitespace(): void {
        while (this.pos < this.text.length) {
            const ch = this.peek();
            if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
                this.advance();
            } else if (ch === '/' && this.peek(1) === '/') {
                // Line comment
                while (this.pos < this.text.length && this.peek() !== '\n') {
                    this.advance();
                }
            } else if (ch === '/' && this.peek(1) === '*') {
                // Block comment
                this.advance(); // /
                this.advance(); // *
                while (this.pos < this.text.length) {
                    if (this.peek() === '*' && this.peek(1) === '/') {
                        this.advance(); // *
                        this.advance(); // /
                        break;
                    }
                    this.advance();
                }
            } else {
                break;
            }
        }
    }

    private readString(): Token {
        const start = this.currentPos();
        this.advance(); // opening quote
        let value = '';
        while (this.pos < this.text.length && this.peek() !== '"') {
            if (this.peek() === '\\') {
                this.advance();
                value += this.advance();
            } else {
                value += this.advance();
            }
        }
        this.advance(); // closing quote
        return {
            type: 'string',
            value,
            range: { start, end: this.currentPos() }
        };
    }

    private readCode(): Token {
        const start = this.currentPos();
        this.advance(); // [
        this.advance(); // {
        let value = '';
        while (this.pos < this.text.length) {
            if (this.peek() === '}' && this.peek(1) === ']') {
                this.advance(); // }
                this.advance(); // ]
                break;
            }
            value += this.advance();
        }
        return {
            type: 'code',
            value,
            range: { start, end: this.currentPos() }
        };
    }

    private readNumber(): Token {
        const start = this.currentPos();
        let value = '';

        if (this.peek() === '-') {
            value += this.advance();
        }

        if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
            value += this.advance(); // 0
            value += this.advance(); // x
            while (/[0-9A-Fa-f]/.test(this.peek())) {
                value += this.advance();
            }
        } else if (this.peek() === '0' && (this.peek(1) === 'b' || this.peek(1) === 'B')) {
            value += this.advance(); // 0
            value += this.advance(); // b
            while (/[01]/.test(this.peek())) {
                value += this.advance();
            }
        } else {
            while (/[0-9]/.test(this.peek())) {
                value += this.advance();
            }
        }

        return {
            type: 'number',
            value,
            range: { start, end: this.currentPos() }
        };
    }

    private readIdentifier(): Token {
        const start = this.currentPos();
        let value = '';
        while (/[a-zA-Z0-9_]/.test(this.peek())) {
            value += this.advance();
        }
        const type = KEYWORDS.has(value) ? 'keyword' : 'identifier';
        return {
            type,
            value,
            range: { start, end: this.currentPos() }
        };
    }

    nextToken(): Token {
        this.skipWhitespace();

        if (this.pos >= this.text.length) {
            return {
                type: 'eof',
                value: '',
                range: { start: this.currentPos(), end: this.currentPos() }
            };
        }

        const start = this.currentPos();
        const ch = this.peek();

        // String
        if (ch === '"') {
            return this.readString();
        }

        // Code block
        if (ch === '[' && this.peek(1) === '{') {
            return this.readCode();
        }

        // Number
        if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(this.peek(1)))) {
            return this.readNumber();
        }

        // Identifier or keyword
        if (/[a-zA-Z_]/.test(ch)) {
            return this.readIdentifier();
        }

        // Bang operator
        if (ch === '!') {
            this.advance();
            let op = '';
            while (/[a-zA-Z]/.test(this.peek())) {
                op += this.advance();
            }
            return {
                type: 'operator',
                value: '!' + op,
                range: { start, end: this.currentPos() }
            };
        }

        // Multi-character operators
        if (ch === '#') {
            this.advance();
            return { type: 'operator', value: '#', range: { start, end: this.currentPos() } };
        }

        // Punctuation
        const punctuation = '{}[]()<>:;,=.';
        if (punctuation.includes(ch)) {
            this.advance();
            return { type: 'punctuation', value: ch, range: { start, end: this.currentPos() } };
        }

        // Unknown - skip
        this.advance();
        return this.nextToken();
    }

    tokenize(): Token[] {
        const tokens: Token[] = [];
        let token: Token;
        do {
            token = this.nextToken();
            tokens.push(token);
        } while (token.type !== 'eof');
        return tokens;
    }
}

export class Parser {
    private tokens: Token[];
    private pos: number = 0;
    private uri: string;
    private errors: ParseError[] = [];

    constructor(tokens: Token[], uri: string) {
        this.tokens = tokens;
        this.uri = uri;
    }

    private peek(offset: number = 0): Token {
        return this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1];
    }

    private advance(): Token {
        return this.tokens[this.pos++];
    }

    private expect(type: TokenType, value?: string): Token {
        const token = this.peek();
        if (token.type !== type || (value !== undefined && token.value !== value)) {
            this.errors.push({
                message: `Expected ${value || type}, got ${token.value}`,
                range: token.range
            });
        }
        return this.advance();
    }

    private match(type: TokenType, value?: string): boolean {
        const token = this.peek();
        return token.type === type && (value === undefined || token.value === value);
    }

    private parseIdentifier(): Identifier {
        const token = this.advance();
        return {
            type: 'Identifier',
            name: token.value,
            range: token.range
        };
    }

    private parseTemplateArgs(): TemplateArg[] {
        const args: TemplateArg[] = [];
        if (!this.match('punctuation', '<')) {
            return args;
        }
        this.advance(); // <

        while (!this.match('punctuation', '>') && !this.match('eof', '')) {
            const startPos = this.pos; // Track position to detect infinite loops
            const start = this.peek().range.start;

            // Parse type
            let argType = '';
            if (this.match('keyword') || this.match('identifier')) {
                argType = this.advance().value;
                // Handle bits<n>
                if (argType === 'bits' && this.match('punctuation', '<')) {
                    argType += '<';
                    this.advance();
                    if (this.match('number')) {
                        argType += this.advance().value;
                    }
                    if (this.match('punctuation', '>')) {
                        argType += '>';
                        this.advance();
                    }
                }
                // Handle list<Type>
                if (argType === 'list' && this.match('punctuation', '<')) {
                    argType += '<';
                    this.advance();
                    if (this.match('keyword') || this.match('identifier')) {
                        argType += this.advance().value;
                    }
                    if (this.match('punctuation', '>')) {
                        argType += '>';
                        this.advance();
                    }
                }
            }

            // Parse name
            let name: Identifier | undefined;
            if (this.match('identifier')) {
                name = this.parseIdentifier();
            }

            // Parse default value
            let defaultValue: Expression | undefined;
            if (this.match('punctuation', '=')) {
                this.advance();
                defaultValue = this.parseExpression();
            }

            if (name) {
                args.push({
                    type: 'TemplateArg',
                    argType,
                    name,
                    defaultValue,
                    range: { start, end: this.peek().range.start }
                });
            }

            if (this.match('punctuation', ',')) {
                this.advance();
            } else if (this.pos === startPos) {
                // No progress made - skip token to avoid infinite loop
                this.advance();
            }
        }

        if (this.match('punctuation', '>')) {
            this.advance();
        }

        return args;
    }

    private parseClassRef(): ClassRef {
        const start = this.peek().range.start;
        const name = this.parseIdentifier();
        const args: Expression[] = [];

        if (this.match('punctuation', '<')) {
            this.advance();
            while (!this.match('punctuation', '>') && !this.match('eof', '')) {
                args.push(this.parseExpression());
                if (this.match('punctuation', ',')) {
                    this.advance();
                }
            }
            if (this.match('punctuation', '>')) {
                this.advance();
            }
        }

        return {
            type: 'ClassRef',
            name,
            args,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseParentClasses(): ClassRef[] {
        const parents: ClassRef[] = [];
        if (!this.match('punctuation', ':')) {
            return parents;
        }
        this.advance(); // :

        while (this.match('identifier')) {
            parents.push(this.parseClassRef());
            if (this.match('punctuation', ',')) {
                this.advance();
            } else {
                break;
            }
        }

        return parents;
    }

    private parseExpression(): Expression {
        return this.parsePrimaryExpression();
    }

    private parsePrimaryExpression(): Expression {
        const token = this.peek();

        // Bang operator
        if (token.type === 'operator' && token.value.startsWith('!')) {
            return this.parseBangOperator();
        }

        // Number
        if (token.type === 'number') {
            this.advance();
            return {
                type: 'NumberLiteral',
                value: parseInt(token.value),
                range: token.range
            };
        }

        // String
        if (token.type === 'string') {
            this.advance();
            return {
                type: 'StringLiteral',
                value: token.value,
                range: token.range
            };
        }

        // Code
        if (token.type === 'code') {
            this.advance();
            return {
                type: 'CodeLiteral',
                value: token.value,
                range: token.range
            };
        }

        // List
        if (this.match('punctuation', '[')) {
            return this.parseList();
        }

        // Dag
        if (this.match('punctuation', '(')) {
            return this.parseDag();
        }

        // Identifier or class ref
        if (token.type === 'identifier') {
            const id = this.parseIdentifier();

            // Check for class instantiation (e.g., Bytecode<>)
            if (this.match('punctuation', '<')) {
                const args: Expression[] = [];
                this.advance(); // <
                while (!this.match('punctuation', '>') && !this.match('eof', '')) {
                    args.push(this.parseExpression());
                    if (this.match('punctuation', ',')) {
                        this.advance();
                    } else if (!this.match('punctuation', '>')) {
                        // Avoid infinite loop - break if we can't make progress
                        break;
                    }
                }
                if (this.match('punctuation', '>')) {
                    this.advance();
                }
                return {
                    type: 'ClassRef',
                    name: id,
                    args,
                    range: { start: id.range.start, end: this.peek().range.start }
                };
            }

            // Check for field access (e.g., t.cBuilder)
            if (this.match('punctuation', '.')) {
                this.advance();
                const field = this.parseIdentifier();
                return {
                    type: 'FieldAccess',
                    object: id,
                    field,
                    range: { start: id.range.start, end: field.range.end }
                };
            }

            return id;
        }

        // Skip unknown and return a placeholder
        this.advance();
        return {
            type: 'Identifier',
            name: '',
            range: token.range
        };
    }

    private parseBangOperator(): Expression {
        const start = this.peek().range.start;
        const opToken = this.advance();
        const operator = opToken.value;
        const typeArgText = this.parseBangTypeArgumentText();
        const args: Expression[] = [];

        if (this.match('punctuation', '(')) {
            this.advance();
            while (!this.match('punctuation', ')') && !this.match('eof', '')) {
                args.push(this.parseExpression());
                if (this.match('punctuation', ',')) {
                    this.advance();
                }
            }
            if (this.match('punctuation', ')')) {
                this.advance();
            }
        }

        return {
            type: 'BangOperator',
            operator,
            typeArgText,
            args,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseBangTypeArgumentText(): string | undefined {
        if (!this.match('punctuation', '<')) {
            return undefined;
        }

        this.advance(); // <
        let angleDepth = 1;
        const typeTokens: string[] = [];

        while (angleDepth > 0 && !this.match('eof', '')) {
            const token = this.advance();

            if (token.type === 'punctuation' && token.value === '<') {
                angleDepth++;
                typeTokens.push(token.value);
                continue;
            }

            if (token.type === 'punctuation' && token.value === '>') {
                angleDepth--;
                if (angleDepth === 0) {
                    break;
                }
                typeTokens.push(token.value);
                continue;
            }

            // Tokens are pre-trimmed, so joining without separators keeps
            // canonical type spellings like Foo<Bar>.
            typeTokens.push(token.type === 'string' ? `"${token.value}"` : token.value);
        }

        const typeArgText = typeTokens.join('').trim();
        return typeArgText.length > 0 ? typeArgText : undefined;
    }

    private parseList(): Expression {
        const start = this.peek().range.start;
        this.advance(); // [
        const elements: Expression[] = [];

        while (!this.match('punctuation', ']') && !this.match('eof', '')) {
            elements.push(this.parseExpression());
            if (this.match('punctuation', ',')) {
                this.advance();
            }
        }

        const end = this.peek().range.end;
        if (this.match('punctuation', ']')) {
            this.advance();
        }

        return {
            type: 'ListExpr',
            elements,
            range: { start, end }
        };
    }

    private parseDag(): Expression {
        const start = this.peek().range.start;
        this.advance(); // (

        const operator = this.parseExpression();
        const args: { value: Expression; name?: Identifier }[] = [];

        while (!this.match('punctuation', ')') && !this.match('eof', '')) {
            const value = this.parseExpression();
            let name: Identifier | undefined;

            if (this.match('punctuation', ':')) {
                this.advance();
                // $name
                if (this.peek().value.startsWith('$')) {
                    const token = this.advance();
                    name = {
                        type: 'Identifier',
                        name: token.value,
                        range: token.range
                    };
                }
            }

            args.push({
                type: 'DagArg',
                value,
                name,
                range: value.range
            } as any);

            if (this.match('punctuation', ',')) {
                this.advance();
            }
        }

        const end = this.peek().range.end;
        if (this.match('punctuation', ')')) {
            this.advance();
        }

        return {
            type: 'DagExpr',
            operator,
            args: args as any,
            range: { start, end }
        };
    }

    private parseBody(): Statement[] {
        const statements: Statement[] = [];

        if (!this.match('punctuation', '{')) {
            return statements;
        }
        this.advance(); // {

        while (!this.match('punctuation', '}') && !this.match('eof', '')) {
            const stmt = this.parseStatement();
            if (stmt) {
                statements.push(stmt);
            }
        }

        if (this.match('punctuation', '}')) {
            this.advance();
        }

        return statements;
    }

    private parseClass(): ClassDef {
        const start = this.peek().range.start;
        this.advance(); // class

        const name = this.parseIdentifier();
        const templateArgs = this.parseTemplateArgs();
        const parentClasses = this.parseParentClasses();

        // A forward declaration is ONLY "class Name;" with nothing else
        // If there are template args, parent classes, or a body, it's a definition
        // Examples:
        //   "class Foo;" - forward declaration
        //   "class Foo<int x>;" - definition (has template args)
        //   "class Foo : Parent;" - definition (has parent class)
        //   "class Foo {}" - definition (has body)
        const hasBody = this.match('punctuation', '{');
        const isForwardDeclaration = !hasBody &&
                                      templateArgs.length === 0 &&
                                      parentClasses.length === 0;

        const body = this.parseBody();

        // Skip trailing semicolon
        if (this.match('punctuation', ';')) {
            this.advance();
        }

        return {
            type: 'ClassDef',
            name,
            templateArgs,
            parentClasses,
            body,
            isForwardDeclaration,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseDef(): RecordDef {
        const start = this.peek().range.start;
        this.advance(); // def

        let name: Identifier | null = null;
        if (this.match('identifier')) {
            name = this.parseIdentifier();
        }

        const parentClasses = this.parseParentClasses();
        const body = this.parseBody();

        if (this.match('punctuation', ';')) {
            this.advance();
        }

        return {
            type: 'RecordDef',
            name,
            parentClasses,
            body,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseMulticlass(): MultiClassDef {
        const start = this.peek().range.start;
        this.advance(); // multiclass

        const name = this.parseIdentifier();
        const templateArgs = this.parseTemplateArgs();
        const parentClasses = this.parseParentClasses();
        const body = this.parseBody();

        return {
            type: 'MultiClassDef',
            name,
            templateArgs,
            parentClasses,
            body,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseDefm(): DefmDef {
        const start = this.peek().range.start;
        this.advance(); // defm

        let name: Identifier | null = null;
        if (this.match('identifier')) {
            name = this.parseIdentifier();
        }

        const parentClasses = this.parseParentClasses();

        if (this.match('punctuation', ';')) {
            this.advance();
        }

        return {
            type: 'DefmDef',
            name,
            parentClasses,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseDefset(): DefsetDef {
        const start = this.peek().range.start;
        this.advance(); // defset

        // Parse type (e.g., "list<Intrinsic>")
        // Need to track bracket depth to properly parse nested types
        let valueType = '';
        let bracketDepth = 0;

        while (true) {
            if (this.match('punctuation', '<')) {
                bracketDepth++;
                valueType += this.advance().value;
            } else if (this.match('punctuation', '>')) {
                bracketDepth--;
                valueType += this.advance().value;
                // If we've closed all brackets, we're done with the type
                if (bracketDepth === 0) {
                    break;
                }
            } else if (bracketDepth > 0) {
                // Inside brackets, consume everything
                if (this.match('keyword') || this.match('identifier') || this.match('punctuation', ',')) {
                    valueType += this.advance().value;
                } else {
                    break;
                }
            } else if (this.match('keyword')) {
                // Keywords like 'list' are part of the type
                valueType += this.advance().value;
            } else {
                break;
            }
        }

        // Parse the defset name - must be an identifier
        let name: Identifier;
        if (this.match('identifier')) {
            name = this.parseIdentifier();
        } else {
            // Create a placeholder if no valid identifier found
            const token = this.peek();
            name = {
                type: 'Identifier',
                name: '',
                range: token.range
            };
        }

        if (this.match('punctuation', '=')) {
            this.advance();
        }

        const body = this.parseBody();

        return {
            type: 'DefsetDef',
            valueType: valueType.trim(),
            name,
            body,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseDefvar(): DefvarDef {
        const start = this.peek().range.start;
        this.advance(); // defvar

        const name = this.parseIdentifier();

        if (this.match('punctuation', '=')) {
            this.advance();
        }

        const value = this.parseExpression();

        if (this.match('punctuation', ';')) {
            this.advance();
        }

        return {
            type: 'DefvarDef',
            name,
            value,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseLet(): LetStatement {
        const start = this.peek().range.start;
        this.advance(); // let

        const bindings: LetBinding[] = [];

        while (this.match('identifier')) {
            const bindingStart = this.peek().range.start;
            const name = this.parseIdentifier();

            if (this.match('punctuation', '=')) {
                this.advance();
            }

            const value = this.parseExpression();

            bindings.push({
                type: 'LetBinding',
                name,
                value,
                range: { start: bindingStart, end: this.peek().range.start }
            });

            if (this.match('punctuation', ',')) {
                this.advance();
            } else {
                break;
            }
        }

        let body: Statement[] = [];
        if (this.match('keyword', 'in')) {
            this.advance();
            if (this.match('punctuation', '{')) {
                body = this.parseBody();
            } else {
                const stmt = this.parseStatement();
                if (stmt) {
                    body = [stmt];
                }
            }
        }

        // Handle field assignment (let field = value;)
        if (this.match('punctuation', ';')) {
            this.advance();
        }

        return {
            type: 'LetStatement',
            bindings,
            body,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseForeach(): ForeachStatement {
        const start = this.peek().range.start;
        this.advance(); // foreach

        const variable = this.parseIdentifier();

        if (this.match('punctuation', '=')) {
            this.advance();
        }

        const iterRange = this.parseExpression();

        let body: Statement[] = [];
        if (this.match('keyword', 'in')) {
            this.advance();
            if (this.match('punctuation', '{')) {
                body = this.parseBody();
            } else {
                const stmt = this.parseStatement();
                if (stmt) {
                    body = [stmt];
                }
            }
        }

        return {
            type: 'ForeachStatement',
            variable,
            iterRange,
            body,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseIf(): IfStatement {
        const start = this.peek().range.start;
        this.advance(); // if

        const condition = this.parseExpression();

        let thenBody: Statement[] = [];
        if (this.match('keyword', 'then')) {
            this.advance();
            if (this.match('punctuation', '{')) {
                thenBody = this.parseBody();
            } else {
                const stmt = this.parseStatement();
                if (stmt) {
                    thenBody = [stmt];
                }
            }
        }

        let elseBody: Statement[] = [];
        if (this.match('keyword', 'else')) {
            this.advance();
            if (this.match('punctuation', '{')) {
                elseBody = this.parseBody();
            } else {
                const stmt = this.parseStatement();
                if (stmt) {
                    elseBody = [stmt];
                }
            }
        }

        return {
            type: 'IfStatement',
            condition,
            thenBody,
            elseBody,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseInclude(): IncludeStatement {
        const start = this.peek().range.start;
        this.advance(); // include

        let path = '';
        if (this.match('string')) {
            path = this.advance().value;
        }

        return {
            type: 'IncludeStatement',
            path,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseAssert(): AssertStatement {
        const start = this.peek().range.start;
        this.advance(); // assert

        const condition = this.parseExpression();

        if (this.match('punctuation', ',')) {
            this.advance();
        }

        const message = this.parseExpression();

        if (this.match('punctuation', ';')) {
            this.advance();
        }

        return {
            type: 'AssertStatement',
            condition,
            message,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseField(): FieldDef {
        const start = this.peek().range.start;

        // Check for 'field' keyword
        let hasFieldKeyword = false;
        if (this.match('keyword', 'field')) {
            hasFieldKeyword = true;
            this.advance();
        }

        // Parse type
        let fieldType = '';
        while (this.match('keyword') || this.match('identifier') ||
               this.match('punctuation', '<') || this.match('punctuation', '>') ||
               this.match('number')) {
            const token = this.peek();
            // Stop if we hit an identifier that looks like a name (followed by = or ;)
            if (token.type === 'identifier') {
                const next = this.peek(1);
                if (next.value === '=' || next.value === ';') {
                    break;
                }
            }
            fieldType += this.advance().value;
        }

        const name = this.parseIdentifier();

        let value: Expression | undefined;
        if (this.match('punctuation', '=')) {
            this.advance();
            value = this.parseExpression();
        }

        if (this.match('punctuation', ';')) {
            this.advance();
        }

        return {
            type: 'FieldDef',
            fieldType: fieldType.trim(),
            name,
            value,
            range: { start, end: this.peek().range.start }
        };
    }

    private parseStatement(): Statement | null {
        const token = this.peek();

        if (token.type === 'eof') {
            return null;
        }

        if (token.type === 'keyword') {
            switch (token.value) {
                case 'class': return this.parseClass();
                case 'def': return this.parseDef();
                case 'multiclass': return this.parseMulticlass();
                case 'defm': return this.parseDefm();
                case 'defset': return this.parseDefset();
                case 'defvar': return this.parseDefvar();
                case 'let': return this.parseLet();
                case 'foreach': return this.parseForeach();
                case 'if': return this.parseIf();
                case 'include': return this.parseInclude();
                case 'assert': return this.parseAssert();
                case 'field':
                case 'bit':
                case 'bits':
                case 'int':
                case 'string':
                case 'list':
                case 'dag':
                case 'code':
                    return this.parseField();
            }
        }

        // Try parsing as a field definition (type name = value;)
        if (token.type === 'identifier') {
            return this.parseField();
        }

        // Skip unknown tokens
        this.advance();
        return null;
    }

    parse(): ParsedFile {
        const statements: Statement[] = [];
        const includes: IncludeStatement[] = [];

        while (!this.match('eof', '')) {
            const stmt = this.parseStatement();
            if (stmt) {
                statements.push(stmt);
                if (stmt.type === 'IncludeStatement') {
                    includes.push(stmt);
                }
            }
        }

        return {
            uri: this.uri,
            statements,
            includes,
            errors: this.errors
        };
    }
}

export function parseTableGen(text: string, uri: string): ParsedFile {
    const lexer = new Lexer(text, uri);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, uri);
    return parser.parse();
}

