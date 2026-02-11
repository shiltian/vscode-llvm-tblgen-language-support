import {
    DefvarDef,
    Expression,
    MultiClassDef,
    Range,
    Statement,
    Symbol,
} from './types';
import { TypeInfo } from './typeSystem';

export function isSameRange(a: Range, b: Range): boolean {
    return a.start.line === b.start.line &&
        a.start.character === b.start.character &&
        a.end.line === b.end.line &&
        a.end.character === b.end.character;
}

export function findDefvarInStatements(
    statements: Statement[],
    defvarName: string,
    targetRange?: Range
): DefvarDef | undefined {
    for (const stmt of statements) {
        switch (stmt.type) {
            case 'DefvarDef': {
                if (stmt.name.name !== defvarName) {
                    break;
                }
                if (!targetRange || isSameRange(stmt.name.range, targetRange)) {
                    return stmt;
                }
                break;
            }
            case 'ClassDef':
            case 'RecordDef':
            case 'MultiClassDef':
            case 'DefsetDef':
            case 'LetStatement':
            case 'ForeachStatement': {
                const nested = findDefvarInStatements(stmt.body, defvarName, targetRange);
                if (nested) {
                    return nested;
                }
                break;
            }
            case 'IfStatement': {
                const nestedThen = findDefvarInStatements(stmt.thenBody, defvarName, targetRange);
                if (nestedThen) {
                    return nestedThen;
                }
                const nestedElse = findDefvarInStatements(stmt.elseBody, defvarName, targetRange);
                if (nestedElse) {
                    return nestedElse;
                }
                break;
            }
        }
    }

    return undefined;
}

export function normalizeCastTypeName(typeArgText: string): string | undefined {
    const trimmed = typeArgText.trim();
    if (!trimmed) {
        return undefined;
    }

    // For !cast<Foo<Bar>>(...) we need the outer type name "Foo".
    const withoutTemplates = trimmed.split('<')[0].trim();
    const match = withoutTemplates.match(/[A-Za-z_][A-Za-z0-9_]*/);
    if (!match) {
        return undefined;
    }

    return match[0];
}

export function inferTypeFromExpression(
    expr: Expression,
    hasClass: (className: string) => boolean
): TypeInfo | undefined {
    if (expr.type !== 'BangOperator') {
        return undefined;
    }

    if (expr.operator !== '!cast' || !expr.typeArgText) {
        return undefined;
    }

    const castTypeName = normalizeCastTypeName(expr.typeArgText);
    if (!castTypeName) {
        return undefined;
    }

    if (!hasClass(castTypeName)) {
        return undefined;
    }

    return { kind: 'class', name: castTypeName };
}

function collectDefSuffixes(
    mc: MultiClassDef,
    findMulticlassNode: (name: string) => MultiClassDef | undefined,
    cache: Map<string, Set<string>>,
    visiting: Set<string> = new Set()
): Set<string> {
    const cacheKey = mc.name.name;
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }

    if (visiting.has(cacheKey)) {
        // Cycle guard for malformed recursive multiclass graphs.
        return new Set();
    }

    visiting.add(cacheKey);

    const suffixes = new Set<string>();

    // Inherit suffixes from parent multiclasses first.
    for (const parent of mc.parentClasses) {
        const parentMc = findMulticlassNode(parent.name.name);
        if (parentMc) {
            for (const inherited of collectDefSuffixes(parentMc, findMulticlassNode, cache, visiting)) {
                suffixes.add(inherited);
            }
        }
    }

    // Then collect local body suffixes (defs, nested defm, and control-flow bodies).
    collectDefSuffixesFromBody(mc.body, findMulticlassNode, suffixes, cache, visiting);

    visiting.delete(cacheKey);

    // Normalize order for deterministic behavior and cache the normalized set.
    const sortedSuffixes = new Set(Array.from(suffixes).sort());
    cache.set(cacheKey, sortedSuffixes);
    return sortedSuffixes;
}

function collectDefSuffixesFromBody(
    body: Statement[],
    findMulticlassNode: (name: string) => MultiClassDef | undefined,
    suffixes: Set<string>,
    cache: Map<string, Set<string>>,
    visiting: Set<string>
): void {
    for (const stmt of body) {
        if (stmt.type === 'RecordDef' && stmt.name) {
            suffixes.add(stmt.name.name);
        } else if (stmt.type === 'DefmDef' && stmt.name) {
            // Nested defm: composite suffix = defm_name + sub-multiclass suffixes
            for (const parent of stmt.parentClasses) {
                const nestedMc = findMulticlassNode(parent.name.name);
                if (nestedMc) {
                    for (const sub of collectDefSuffixes(nestedMc, findMulticlassNode, cache, visiting)) {
                        suffixes.add(stmt.name.name + sub);
                    }
                }
            }
        } else if (
            stmt.type === 'DefsetDef' ||
            stmt.type === 'ForeachStatement' ||
            stmt.type === 'LetStatement'
        ) {
            collectDefSuffixesFromBody(stmt.body, findMulticlassNode, suffixes, cache, visiting);
        } else if (stmt.type === 'IfStatement') {
            collectDefSuffixesFromBody(stmt.thenBody, findMulticlassNode, suffixes, cache, visiting);
            collectDefSuffixesFromBody(stmt.elseBody, findMulticlassNode, suffixes, cache, visiting);
        }
    }
}

function collectCompositeDefmSymbolsFromStatements(
    statements: Statement[],
    uri: string,
    findMulticlassNode: (name: string) => MultiClassDef | undefined,
    suffixCache: Map<string, Set<string>>,
    collected: Symbol[]
): void {
    for (const stmt of statements) {
        if (stmt.type === 'DefmDef' && stmt.name) {
            const defmName = stmt.name.name;
            const defmLocation = { uri, range: stmt.name.range };
            const compositeNames = new Set<string>();
            for (const parent of stmt.parentClasses) {
                const mcDef = findMulticlassNode(parent.name.name);
                if (mcDef) {
                    const suffixes = collectDefSuffixes(mcDef, findMulticlassNode, suffixCache);
                    for (const suffix of suffixes) {
                        compositeNames.add(defmName + suffix);
                    }
                }
            }

            for (const compositeName of Array.from(compositeNames).sort()) {
                collected.push({
                    name: compositeName,
                    kind: 'def',
                    location: defmLocation,
                });
            }
        } else if (
            stmt.type === 'DefsetDef' ||
            stmt.type === 'ForeachStatement' ||
            stmt.type === 'LetStatement'
        ) {
            collectCompositeDefmSymbolsFromStatements(
                stmt.body,
                uri,
                findMulticlassNode,
                suffixCache,
                collected
            );
        } else if (stmt.type === 'IfStatement') {
            collectCompositeDefmSymbolsFromStatements(
                stmt.thenBody,
                uri,
                findMulticlassNode,
                suffixCache,
                collected
            );
            collectCompositeDefmSymbolsFromStatements(
                stmt.elseBody,
                uri,
                findMulticlassNode,
                suffixCache,
                collected
            );
        }
    }
}

export function computeCompositeDefmSymbols(
    statements: Statement[],
    uri: string,
    findMulticlassNode: (name: string) => MultiClassDef | undefined
): Symbol[] {
    const symbols: Symbol[] = [];
    const suffixCache = new Map<string, Set<string>>();
    collectCompositeDefmSymbolsFromStatements(
        statements,
        uri,
        findMulticlassNode,
        suffixCache,
        symbols
    );
    return symbols;
}
