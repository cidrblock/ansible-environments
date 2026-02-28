/**
 * Ansible Content Designer - Schema Generator
 * 
 * Generates Zod schemas and JSON Schemas from the SQLite database schema.
 * This ensures a single source of truth: the SQL schema file.
 */

import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { DesignerDatabase, ColumnInfo } from './DesignerDatabase';

/**
 * Parsed CHECK constraint information
 */
interface CheckConstraint {
    column: string;
    type: 'enum' | 'glob' | 'length' | 'range' | 'custom';
    values?: string[];
    pattern?: string;
    min?: number;
    max?: number;
    expression?: string;
}

/**
 * SchemaGenerator - Generates validation schemas from SQL
 * 
 * Parses CREATE TABLE statements and generates:
 * - Zod schemas for TypeScript validation
 * - JSON Schemas for MCP tool descriptions
 */
export class SchemaGenerator {
    private db: DesignerDatabase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private schemas: Map<string, z.ZodObject<any>> = new Map();
    private jsonSchemas: Map<string, object> = new Map();

    constructor(db: DesignerDatabase) {
        this.db = db;
    }

    /**
     * Generate schemas for all tables
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public generateAllSchemas(): Map<string, z.ZodObject<any>> {
        const tableNames = this.db.getTableNames();
        
        for (const tableName of tableNames) {
            try {
                const schema = this.generateTableSchema(tableName);
                this.schemas.set(tableName, schema);
                // Use type assertion for zodToJsonSchema compatibility
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.jsonSchemas.set(tableName, zodToJsonSchema(schema as any));
            } catch (error) {
                console.error(`Failed to generate schema for ${tableName}:`, error);
            }
        }

        return this.schemas;
    }

    /**
     * Generate Zod schema for a single table
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public generateTableSchema(tableName: string): z.ZodObject<any> {
        const columns = this.db.getTableInfo(tableName);
        const ddl = this.db.getTableDDL(tableName);
        const checks = ddl ? this._parseCheckConstraints(ddl) : [];

        const shape: Record<string, ZodTypeAny> = {};

        for (const col of columns) {
            let zodType = this._columnToZod(col, checks);
            
            // Make optional if nullable and no default
            if (!col.notnull && col.dflt_value === null) {
                zodType = zodType.optional();
            }
            
            // Handle default values - also make optional
            if (col.dflt_value !== null) {
                zodType = zodType.optional();
            }

            shape[col.name] = zodType;
        }

        return z.object(shape);
    }

    /**
     * Convert SQLite column to Zod type
     */
    private _columnToZod(col: ColumnInfo, checks: CheckConstraint[]): ZodTypeAny {
        const colChecks = checks.filter(c => c.column === col.name);
        
        // Handle CHECK IN (...) - enum constraint
        const enumCheck = colChecks.find(c => c.type === 'enum');
        if (enumCheck && enumCheck.values && enumCheck.values.length > 0) {
            return z.enum(enumCheck.values as [string, ...string[]]);
        }

        // Handle CHECK GLOB - pattern constraint
        const globCheck = colChecks.find(c => c.type === 'glob');
        if (globCheck && globCheck.pattern) {
            return z.string().regex(this._globToRegex(globCheck.pattern));
        }

        // Handle CHECK length()
        const lengthCheck = colChecks.find(c => c.type === 'length');
        if (lengthCheck) {
            let s = z.string();
            if (lengthCheck.min !== undefined) {
                s = s.min(lengthCheck.min);
            }
            if (lengthCheck.max !== undefined) {
                s = s.max(lengthCheck.max);
            }
            return s;
        }

        // Map SQL type to Zod type
        const sqlType = col.type.toUpperCase();
        
        if (sqlType.includes('INT')) {
            // Handle range constraints
            const rangeCheck = colChecks.find(c => c.type === 'range');
            let num = z.number().int();
            if (rangeCheck) {
                if (rangeCheck.min !== undefined) {
                    num = num.min(rangeCheck.min);
                }
                if (rangeCheck.max !== undefined) {
                    num = num.max(rangeCheck.max);
                }
            }
            return num;
        }
        
        if (sqlType.includes('REAL') || sqlType.includes('FLOAT') || sqlType.includes('DOUBLE')) {
            return z.number();
        }
        
        if (sqlType.includes('BOOL')) {
            return z.boolean();
        }
        
        if (sqlType.includes('BLOB')) {
            return z.instanceof(Buffer);
        }
        
        if (sqlType.includes('DATETIME') || sqlType.includes('TIMESTAMP')) {
            // Accept ISO date strings
            return z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/));
        }

        // Default to string
        return z.string();
    }

    /**
     * Parse CHECK constraints from CREATE TABLE statement
     */
    private _parseCheckConstraints(ddl: string): CheckConstraint[] {
        const constraints: CheckConstraint[] = [];
        
        // Match CHECK constraints with column context
        // Handles: column_name TYPE CHECK (expression)
        const columnCheckRegex = /(\w+)\s+\w+[^,]*CHECK\s*\(([^)]+)\)/gi;
        let match;
        
        while ((match = columnCheckRegex.exec(ddl)) !== null) {
            const column = match[1];
            const expression = match[2];
            
            const parsed = this._parseCheckExpression(column, expression);
            if (parsed) {
                constraints.push(parsed);
            }
        }
        
        // Also handle standalone CHECK constraints (table-level)
        const tableCheckRegex = /,\s*CHECK\s*\(([^)]+)\)/gi;
        while ((match = tableCheckRegex.exec(ddl)) !== null) {
            const expression = match[1];
            // Try to extract column from expression
            const colMatch = expression.match(/^(\w+)\s+(IN|GLOB|=)/i);
            if (colMatch) {
                const parsed = this._parseCheckExpression(colMatch[1], expression);
                if (parsed) {
                    constraints.push(parsed);
                }
            }
        }

        return constraints;
    }

    /**
     * Parse a single CHECK expression
     */
    private _parseCheckExpression(column: string, expression: string): CheckConstraint | null {
        const expr = expression.trim();
        
        // Check for IN ('value1', 'value2', ...)
        const inMatch = expr.match(/(\w+)\s+IN\s*\(([^)]+)\)/i);
        if (inMatch && inMatch[1].toLowerCase() === column.toLowerCase()) {
            const valuesStr = inMatch[2];
            const values = valuesStr
                .split(',')
                .map(v => v.trim().replace(/^['"]|['"]$/g, ''))
                .filter(v => v.length > 0);
            
            return {
                column,
                type: 'enum',
                values
            };
        }

        // Check for GLOB 'pattern'
        const globMatch = expr.match(/(\w+)\s+GLOB\s+['"]([^'"]+)['"]/i);
        if (globMatch && globMatch[1].toLowerCase() === column.toLowerCase()) {
            return {
                column,
                type: 'glob',
                pattern: globMatch[2]
            };
        }

        // Check for length(column) >= N
        const lengthMinMatch = expr.match(/length\s*\(\s*(\w+)\s*\)\s*>=\s*(\d+)/i);
        if (lengthMinMatch && lengthMinMatch[1].toLowerCase() === column.toLowerCase()) {
            return {
                column,
                type: 'length',
                min: parseInt(lengthMinMatch[2], 10)
            };
        }

        // Check for length(column) <= N
        const lengthMaxMatch = expr.match(/length\s*\(\s*(\w+)\s*\)\s*<=\s*(\d+)/i);
        if (lengthMaxMatch && lengthMaxMatch[1].toLowerCase() === column.toLowerCase()) {
            return {
                column,
                type: 'length',
                max: parseInt(lengthMaxMatch[2], 10)
            };
        }

        // Check for column >= min AND column <= max
        const rangeMatch = expr.match(/(\w+)\s*>=\s*(\d+)\s+AND\s+\w+\s*<=\s*(\d+)/i);
        if (rangeMatch && rangeMatch[1].toLowerCase() === column.toLowerCase()) {
            return {
                column,
                type: 'range',
                min: parseInt(rangeMatch[2], 10),
                max: parseInt(rangeMatch[3], 10)
            };
        }

        return null;
    }

    /**
     * Convert SQLite GLOB pattern to JavaScript RegExp
     */
    private _globToRegex(glob: string): RegExp {
        // Escape regex special chars except glob wildcards
        let pattern = glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
            .replace(/\[!/g, '[^');
        
        return new RegExp(`^${pattern}$`);
    }

    // ========================================================================
    // Schema Access
    // ========================================================================

    /**
     * Get Zod schema for a table
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public getSchema(tableName: string): z.ZodObject<any> | undefined {
        if (!this.schemas.has(tableName)) {
            try {
                const schema = this.generateTableSchema(tableName);
                this.schemas.set(tableName, schema);
            } catch {
                return undefined;
            }
        }
        return this.schemas.get(tableName);
    }

    /**
     * Get all Zod schemas
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public getSchemas(): Map<string, z.ZodObject<any>> {
        if (this.schemas.size === 0) {
            this.generateAllSchemas();
        }
        return this.schemas;
    }

    /**
     * Get JSON Schema for a table (for MCP tool descriptions)
     */
    public getJsonSchema(tableName: string): object | undefined {
        if (!this.jsonSchemas.has(tableName)) {
            const zodSchema = this.getSchema(tableName);
            if (zodSchema) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.jsonSchemas.set(tableName, zodToJsonSchema(zodSchema as any));
            }
        }
        return this.jsonSchemas.get(tableName);
    }

    /**
     * Get all JSON Schemas
     */
    public getJsonSchemas(): Record<string, object> {
        if (this.schemas.size === 0) {
            this.generateAllSchemas();
        }
        
        const result: Record<string, object> = {};
        for (const [name, schema] of this.schemas) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            result[name] = zodToJsonSchema(schema as any);
        }
        return result;
    }

    // ========================================================================
    // Validation
    // ========================================================================

    /**
     * Validate data against a table's schema
     */
    public validate<T>(tableName: string, data: unknown): { success: true; data: T } | { success: false; errors: string[] } {
        const schema = this.getSchema(tableName);
        if (!schema) {
            return { success: false, errors: [`No schema found for table: ${tableName}`] };
        }

        const result = schema.safeParse(data);
        if (result.success) {
            return { success: true, data: result.data as T };
        } else {
            // Zod 4 uses result.error.issues instead of errors
            const issues = 'issues' in result.error ? result.error.issues : [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const errors = (issues as any[]).map((e: { path: (string | number)[]; message: string }) => 
                `${e.path.join('.')}: ${e.message}`
            );
            return { success: false, errors };
        }
    }
}
