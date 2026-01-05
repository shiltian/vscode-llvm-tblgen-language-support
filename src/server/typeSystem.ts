/**
 * Type System for TableGen
 *
 * Handles:
 * - Class definitions with fields and types
 * - Inheritance relationships
 * - Type resolution for field access (X.field)
 * - Template/class argument types
 */

import { Location, Range, ParsedFile, ClassDef, RecordDef, MultiClassDef, FieldDef, TemplateArg, Statement, Expression, ClassRef } from './types';

// Represents a TableGen type
export interface TypeInfo {
    kind: 'builtin' | 'class' | 'list' | 'bits' | 'dag';
    name: string;  // For class types, the class name
    elementType?: TypeInfo;  // For list<T>
    bitWidth?: number;  // For bits<n>
}

// Information about a field in a class
export interface FieldInfo {
    name: string;
    type: TypeInfo;
    location: Location;
    declaringClass: string;  // The class where this field is defined (not inherited)
}

// Information about a class/def argument
export interface ArgumentInfo {
    name: string;
    type: TypeInfo;
    location: Location;
    hasDefault: boolean;
}

// Information about a class
export interface ClassInfo {
    name: string;
    kind: 'class' | 'multiclass' | 'def' | 'defm';
    location: Location;
    uri: string;
    parentClasses: string[];  // Names of parent classes
    arguments: ArgumentInfo[];  // Template arguments
    fields: Map<string, FieldInfo>;  // Fields defined in this class (not inherited)
    allFields?: Map<string, FieldInfo>;  // Cached: all fields including inherited
    isForwardDeclaration: boolean;  // true for "class Foo;" without body
}

// Built-in types
const BUILTIN_TYPES = new Set(['bit', 'int', 'string', 'code', 'dag']);

/**
 * Parse a type string into TypeInfo
 */
export function parseTypeString(typeStr: string): TypeInfo {
    if (!typeStr) {
        return { kind: 'builtin', name: 'unknown' };
    }

    // bits<n>
    const bitsMatch = typeStr.match(/^bits<(\d+)>$/);
    if (bitsMatch) {
        return { kind: 'bits', name: 'bits', bitWidth: parseInt(bitsMatch[1], 10) };
    }

    // list<Type>
    const listMatch = typeStr.match(/^list<(.+)>$/);
    if (listMatch) {
        return { kind: 'list', name: 'list', elementType: parseTypeString(listMatch[1]) };
    }

    // Built-in types
    if (BUILTIN_TYPES.has(typeStr)) {
        return { kind: 'builtin', name: typeStr };
    }

    // Class type
    return { kind: 'class', name: typeStr };
}

/**
 * The TableGen Type System
 */
export class TypeSystem {
    // All known classes (by name)
    private classes: Map<string, ClassInfo> = new Map();

    // File URI -> classes defined in that file
    private fileClasses: Map<string, Set<string>> = new Map();

    /**
     * Clear all type information
     */
    clear(): void {
        this.classes.clear();
        this.fileClasses.clear();
    }

    /**
     * Clear type information for a specific file
     */
    clearFile(uri: string): void {
        const classNames = this.fileClasses.get(uri);
        if (classNames) {
            for (const name of classNames) {
                this.classes.delete(name);
            }
            this.fileClasses.delete(uri);
        }
    }

    /**
     * Add a class to the type system
     */
    addClass(info: ClassInfo): void {
        // If we already have this class, prefer definition over forward declaration
        const existing = this.classes.get(info.name);
        if (existing) {
            // If existing is a definition and new is a forward declaration, keep existing
            if (!existing.isForwardDeclaration && info.isForwardDeclaration) {
                return;
            }
            // Otherwise, new one takes precedence (either new is definition, or both are same kind)
        }

        this.classes.set(info.name, info);

        if (!this.fileClasses.has(info.uri)) {
            this.fileClasses.set(info.uri, new Set());
        }
        this.fileClasses.get(info.uri)!.add(info.name);

        // Invalidate cached allFields for this class and all subclasses
        info.allFields = undefined;
    }

    /**
     * Get a class by name
     */
    getClass(name: string): ClassInfo | undefined {
        return this.classes.get(name);
    }

    /**
     * Get all classes
     */
    getAllClasses(): ClassInfo[] {
        return Array.from(this.classes.values());
    }

    /**
     * Get all fields for a class, including inherited fields
     */
    getAllFields(className: string): Map<string, FieldInfo> {
        const classInfo = this.classes.get(className);
        if (!classInfo) {
            return new Map();
        }

        // Return cached if available
        if (classInfo.allFields) {
            return classInfo.allFields;
        }

        // Build all fields by walking inheritance chain
        const allFields = new Map<string, FieldInfo>();

        // First, add fields from parent classes (in order)
        for (const parentName of classInfo.parentClasses) {
            const parentFields = this.getAllFields(parentName);
            for (const [name, field] of parentFields) {
                allFields.set(name, field);
            }
        }

        // Then add/override with this class's own fields
        for (const [name, field] of classInfo.fields) {
            allFields.set(name, field);
        }

        // Cache the result
        classInfo.allFields = allFields;
        return allFields;
    }

    /**
     * Find where a field is originally defined in a class hierarchy
     */
    findFieldDefinition(className: string, fieldName: string): FieldInfo | undefined {
        const classInfo = this.classes.get(className);
        if (!classInfo) {
            return undefined;
        }

        // Check this class's own fields first
        const ownField = classInfo.fields.get(fieldName);
        if (ownField) {
            return ownField;
        }

        // Check parent classes
        for (const parentName of classInfo.parentClasses) {
            const parentField = this.findFieldDefinition(parentName, fieldName);
            if (parentField) {
                return parentField;
            }
        }

        return undefined;
    }

    /**
     * Find a field for a let binding - search up the inheritance chain
     * This is used for "let X = Y" where X is defined in a parent class
     */
    findLetTargetField(className: string, fieldName: string): FieldInfo | undefined {
        return this.findFieldDefinition(className, fieldName);
    }

    /**
     * Resolve the type of a field access expression (X.field)
     * Returns the field info if found
     */
    resolveFieldAccess(baseType: TypeInfo, fieldName: string): FieldInfo | undefined {
        if (baseType.kind !== 'class') {
            // Built-in types and lists don't have accessible fields
            return undefined;
        }

        return this.findFieldDefinition(baseType.name, fieldName);
    }

    /**
     * Get the type of an argument in a class
     */
    getArgumentType(className: string, argName: string): TypeInfo | undefined {
        const classInfo = this.classes.get(className);
        if (!classInfo) {
            return undefined;
        }

        // Check this class's arguments
        for (const arg of classInfo.arguments) {
            if (arg.name === argName) {
                return arg.type;
            }
        }

        // Arguments are not inherited
        return undefined;
    }

    /**
     * Get the location of an argument definition
     */
    getArgumentLocation(className: string, argName: string): Location | undefined {
        const classInfo = this.classes.get(className);
        if (!classInfo) {
            return undefined;
        }

        for (const arg of classInfo.arguments) {
            if (arg.name === argName) {
                return arg.location;
            }
        }

        return undefined;
    }

    /**
     * Check if a class inherits from another class (directly or indirectly)
     */
    inheritsFrom(className: string, parentName: string): boolean {
        const classInfo = this.classes.get(className);
        if (!classInfo) {
            return false;
        }

        // Direct parent
        if (classInfo.parentClasses.includes(parentName)) {
            return true;
        }

        // Indirect parent
        for (const parent of classInfo.parentClasses) {
            if (this.inheritsFrom(parent, parentName)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get all parent classes (direct and indirect)
     */
    getAllParentClasses(className: string): string[] {
        const parents: string[] = [];
        const visited = new Set<string>();

        const collect = (name: string) => {
            const classInfo = this.classes.get(name);
            if (!classInfo || visited.has(name)) {
                return;
            }
            visited.add(name);

            for (const parent of classInfo.parentClasses) {
                if (!parents.includes(parent)) {
                    parents.push(parent);
                }
                collect(parent);
            }
        };

        collect(className);
        return parents;
    }
}

/**
 * Collect type information from parsed files
 */
export class TypeCollector {
    private typeSystem: TypeSystem;
    private uri: string;

    constructor(typeSystem: TypeSystem, uri: string) {
        this.typeSystem = typeSystem;
        this.uri = uri;
    }

    /**
     * Collect types from a parsed file
     */
    collect(parsed: ParsedFile): void {
        for (const stmt of parsed.statements) {
            this.collectStatement(stmt);
        }
    }

    private collectStatement(stmt: Statement): void {
        switch (stmt.type) {
            case 'ClassDef':
                this.collectClassDef(stmt);
                break;
            case 'MultiClassDef':
                this.collectMultiClassDef(stmt);
                break;
            case 'RecordDef':
                this.collectRecordDef(stmt);
                break;
            case 'DefmDef':
                this.collectDefmDef(stmt);
                break;
            case 'LetStatement':
                // Let statements can contain nested definitions
                for (const bodyStmt of stmt.body) {
                    this.collectStatement(bodyStmt);
                }
                break;
            case 'ForeachStatement':
                for (const bodyStmt of stmt.body) {
                    this.collectStatement(bodyStmt);
                }
                break;
            case 'IfStatement':
                for (const bodyStmt of stmt.thenBody) {
                    this.collectStatement(bodyStmt);
                }
                for (const bodyStmt of stmt.elseBody) {
                    this.collectStatement(bodyStmt);
                }
                break;
        }
    }

    private collectClassDef(classDef: ClassDef): void {
        const classInfo: ClassInfo = {
            name: classDef.name.name,
            kind: 'class',
            location: { uri: this.uri, range: classDef.name.range },
            uri: this.uri,
            parentClasses: classDef.parentClasses.map(p => p.name.name),
            arguments: this.collectArguments(classDef.templateArgs),
            fields: this.collectFields(classDef.body),
            isForwardDeclaration: classDef.isForwardDeclaration,
        };

        this.typeSystem.addClass(classInfo);
    }

    private collectMultiClassDef(multiclassDef: MultiClassDef): void {
        const classInfo: ClassInfo = {
            name: multiclassDef.name.name,
            kind: 'multiclass',
            location: { uri: this.uri, range: multiclassDef.name.range },
            uri: this.uri,
            parentClasses: multiclassDef.parentClasses.map(p => p.name.name),
            arguments: this.collectArguments(multiclassDef.templateArgs),
            fields: this.collectFields(multiclassDef.body),
            isForwardDeclaration: false, // multiclass can't be forward declared
        };

        this.typeSystem.addClass(classInfo);
    }

    private collectRecordDef(recordDef: RecordDef): void {
        if (!recordDef.name) {
            return; // Skip anonymous defs
        }

        const classInfo: ClassInfo = {
            name: recordDef.name.name,
            kind: 'def',
            location: { uri: this.uri, range: recordDef.name.range },
            uri: this.uri,
            parentClasses: recordDef.parentClasses.map(p => p.name.name),
            arguments: [],
            fields: this.collectFields(recordDef.body),
            isForwardDeclaration: false, // def can't be forward declared
        };

        this.typeSystem.addClass(classInfo);
    }

    private collectDefmDef(defmDef: any): void {
        if (!defmDef.name) {
            return; // Skip anonymous defms
        }

        const classInfo: ClassInfo = {
            name: defmDef.name.name,
            kind: 'defm',
            location: { uri: this.uri, range: defmDef.name.range },
            uri: this.uri,
            parentClasses: defmDef.parentClasses.map((p: ClassRef) => p.name.name),
            arguments: [],
            fields: new Map(),
            isForwardDeclaration: false, // defm can't be forward declared
        };

        this.typeSystem.addClass(classInfo);
    }

    private collectArguments(templateArgs: TemplateArg[]): ArgumentInfo[] {
        return templateArgs.map(arg => ({
            name: arg.name.name,
            type: parseTypeString(arg.argType),
            location: { uri: this.uri, range: arg.name.range },
            hasDefault: arg.defaultValue !== undefined,
        }));
    }

    private collectFields(body: Statement[]): Map<string, FieldInfo> {
        const fields = new Map<string, FieldInfo>();

        for (const stmt of body) {
            if (stmt.type === 'FieldDef') {
                const fieldDef = stmt as FieldDef;
                fields.set(fieldDef.name.name, {
                    name: fieldDef.name.name,
                    type: parseTypeString(fieldDef.fieldType),
                    location: { uri: this.uri, range: fieldDef.name.range },
                    declaringClass: '', // Will be set by the class that contains this
                });
            }
        }

        return fields;
    }
}

