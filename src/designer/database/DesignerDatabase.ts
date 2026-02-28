/**
 * Ansible Content Designer - Database Operations
 * 
 * SQLite database wrapper using sql.js (pure JavaScript, no native modules).
 * Handles initialization, schema management, and query execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database as SqlJsDatabase, SqlValue } from 'sql.js';
import type { QueryResult, HistoryEntry } from '../types/designer';

/**
 * Path to the SQL schema file
 */
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Forbidden keywords in user queries
 */
const FORBIDDEN_KEYWORDS = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 
    'attach', 'detach', 'vacuum', 'reindex', 'replace', 'truncate'
];

/**
 * Run result interface (matches better-sqlite3 for compatibility)
 */
export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
}

/**
 * DesignerDatabase - SQLite database wrapper using sql.js
 * 
 * Provides:
 * - Database initialization and schema management
 * - Read-only query execution for MCP tools
 * - History/audit logging
 * - Auto-save to disk
 */
export class DesignerDatabase {
    private db: SqlJsDatabase | null = null;
    private workspaceRoot: string;
    private dbPath: string;
    private initialized: boolean = false;
    private dirty: boolean = false;
    private inTransaction: boolean = false;

    /**
     * Create a new DesignerDatabase instance
     * 
     * @param workspaceRoot - The workspace root directory
     */
    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.dbPath = path.join(workspaceRoot, 'design', 'design.db');
    }

    /**
     * Check if a design database exists in the workspace
     */
    public exists(): boolean {
        return fs.existsSync(this.dbPath);
    }

    /**
     * Get the path to the database file
     */
    public getPath(): string {
        return this.dbPath;
    }

    /**
     * Initialize the database
     * 
     * Creates the database file and applies schema if it doesn't exist.
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // Ensure design directory exists
        const designDir = path.dirname(this.dbPath);
        if (!fs.existsSync(designDir)) {
            fs.mkdirSync(designDir, { recursive: true });
        }

        // Initialize sql.js
        const SQL = await initSqlJs();

        // Open or create database
        const isNew = !fs.existsSync(this.dbPath);
        
        if (isNew) {
            this.db = new SQL.Database();
        } else {
            const buffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(buffer);
        }

        // Enable foreign keys
        this.db.run('PRAGMA foreign_keys = ON');

        // Apply schema if new database
        if (isNew) {
            await this._applySchema();
        } else {
            // Apply migrations to existing database
            this._applyMigrations();
        }

        this.initialized = true;
    }

    /**
     * Apply the SQL schema to the database
     */
    private async _applySchema(): Promise<void> {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        // Read schema file
        let schemaPath = SCHEMA_PATH;
        
        // Handle both development and packaged extension paths
        if (!fs.existsSync(schemaPath)) {
            schemaPath = path.join(__dirname, '..', '..', '..', 'src', 'designer', 'database', 'schema.sql');
        }
        
        if (!fs.existsSync(schemaPath)) {
            throw new Error(`Schema file not found: ${SCHEMA_PATH}`);
        }

        const schema = fs.readFileSync(schemaPath, 'utf-8');
        
        // Execute schema
        this.db.run(schema);
        this.dirty = true;
        
        // Apply migrations for existing databases
        this._applyMigrations();
        
        // Save to disk
        this._save();
        
        // Log creation
        this._logHistory('database_created', 'database', undefined, undefined, {
            path: this.dbPath,
            schema_version: '1.0.0'
        });
    }

    /**
     * Save database to disk
     */
    private _save(): void {
        if (!this.db || !this.dirty) {
            return;
        }

        const data = this.db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(this.dbPath, buffer);
        this.dirty = false;
    }

    /**
     * Close database connections
     */
    public close(): void {
        if (this.db) {
            this._save();
            this.db.close();
            this.db = null;
        }
        this.initialized = false;
    }

    /**
     * Get the raw database connection (for advanced operations)
     * 
     * WARNING: Use with care - prefer service methods
     */
    public getConnection(): SqlJsDatabase {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        return this.db;
    }

    // ========================================================================
    // Read-only Query Execution (for MCP tools)
    // ========================================================================

    /**
     * Execute a read-only SELECT query
     * 
     * Safety features:
     * - Only SELECT queries allowed
     * - Dangerous keywords blocked
     * - Result size limited
     * 
     * @param sql - The SQL query to execute
     * @param limit - Maximum rows to return (default 100, max 1000)
     * @returns Query result with rows or error
     */
    public executeReadonlyQuery(sql: string, limit: number = 100): QueryResult {
        if (!this.db) {
            return {
                success: false,
                error: 'Database not initialized',
                hint: 'Call initialize() first or check if design.db exists'
            };
        }

        // Validate query is SELECT only
        const normalized = sql.trim().toLowerCase();
        if (!normalized.startsWith('select')) {
            return {
                success: false,
                error: 'Only SELECT queries are allowed',
                hint: 'Use SELECT to query data. Example: SELECT * FROM requirements'
            };
        }

        // Block dangerous patterns
        for (const keyword of FORBIDDEN_KEYWORDS) {
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (regex.test(sql)) {
                return {
                    success: false,
                    error: `Query contains forbidden keyword: ${keyword}`,
                    hint: 'Only SELECT queries are allowed for reading data'
                };
            }
        }

        // Bound the limit
        const boundedLimit = Math.min(Math.max(1, limit), 1000);
        
        // Check if query already has LIMIT
        const hasLimit = /\blimit\s+\d+/i.test(sql);
        const finalSql = hasLimit ? sql : `${sql} LIMIT ${boundedLimit}`;

        try {
            const result = this.db.exec(finalSql);
            
            if (result.length === 0) {
                return {
                    success: true,
                    rowCount: 0,
                    columns: [],
                    rows: [],
                    truncated: false
                };
            }

            const columns = result[0].columns;
            const rows = result[0].values.map(row => {
                const obj: Record<string, unknown> = {};
                columns.forEach((col, idx) => {
                    obj[col] = row[idx];
                });
                return obj;
            });

            // Log query to history
            this._logHistory('query_executed', 'query', undefined, undefined, {
                query: sql.substring(0, 500),
                row_count: rows.length
            });

            return {
                success: true,
                rowCount: rows.length,
                columns: columns,
                rows: rows,
                truncated: rows.length === boundedLimit && !hasLimit
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: message,
                hint: 'Check your SQL syntax. Use "SELECT * FROM sqlite_master WHERE type=\'table\'" to see available tables.'
            };
        }
    }

    // ========================================================================
    // Schema Introspection
    // ========================================================================

    /**
     * Get the database schema as human-readable text
     */
    public getSchema(): string {
        if (!this.db) {
            return 'Database not initialized';
        }

        const result = this.db.exec(`
            SELECT name, sql FROM sqlite_master 
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `);

        if (result.length === 0) {
            return 'No tables found';
        }

        const lines: string[] = ['# Content Designer Database Schema\n'];

        for (const row of result[0].values) {
            const name = row[0] as string;
            const sql = row[1] as string;
            lines.push(`## ${name}\n`);
            lines.push('```sql');
            lines.push(sql);
            lines.push('```\n');
        }

        return lines.join('\n');
    }

    /**
     * Get the raw SQL schema
     */
    public getRawSchema(): string {
        if (!this.db) {
            return '';
        }

        const result = this.db.exec(`
            SELECT sql FROM sqlite_master 
            WHERE sql IS NOT NULL
            ORDER BY type, name
        `);

        if (result.length === 0) {
            return '';
        }

        return result[0].values.map(r => r[0]).join(';\n\n') + ';';
    }

    /**
     * Get table information for schema generation
     */
    public getTableInfo(tableName: string): ColumnInfo[] {
        if (!this.db) {
            return [];
        }

        const result = this.db.exec(`PRAGMA table_info("${tableName}")`);
        
        if (result.length === 0) {
            return [];
        }

        return result[0].values.map(row => ({
            cid: row[0] as number,
            name: row[1] as string,
            type: row[2] as string,
            notnull: row[3] as number,
            dflt_value: row[4] as string | null,
            pk: row[5] as number
        }));
    }

    /**
     * Get all table names
     */
    public getTableNames(): string[] {
        if (!this.db) {
            return [];
        }

        const result = this.db.exec(`
            SELECT name FROM sqlite_master 
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
        `);

        if (result.length === 0) {
            return [];
        }

        return result[0].values.map(r => r[0] as string);
    }

    /**
     * Get CREATE TABLE statement for a table
     */
    public getTableDDL(tableName: string): string | null {
        if (!this.db) {
            return null;
        }

        const result = this.db.exec(`
            SELECT sql FROM sqlite_master 
            WHERE type = 'table' AND name = '${tableName}'
        `);

        if (result.length === 0 || result[0].values.length === 0) {
            return null;
        }

        return result[0].values[0][0] as string;
    }

    // ========================================================================
    // History / Audit Logging
    // ========================================================================

    /**
     * Apply database migrations for schema updates
     * This handles upgrading existing databases to new schema versions
     */
    private _applyMigrations(): void {
        if (!this.db) {
            return;
        }

        // Check if design_decisions table has the new columns
        const tableInfo = this.db.exec('PRAGMA table_info(design_decisions)');
        if (tableInfo.length > 0) {
            const columns = tableInfo[0].values.map(row => row[1] as string);
            
            // Migration 1: Add question_type, choices, suggested_default columns
            if (!columns.includes('question_type')) {
                console.log('DesignerDatabase: Migrating - adding question_type column');
                this.db.run(`ALTER TABLE design_decisions ADD COLUMN question_type TEXT DEFAULT 'text'`);
                this.dirty = true;
            }
            
            if (!columns.includes('choices')) {
                console.log('DesignerDatabase: Migrating - adding choices column');
                this.db.run(`ALTER TABLE design_decisions ADD COLUMN choices TEXT`);
                this.dirty = true;
            }
            
            if (!columns.includes('suggested_default')) {
                console.log('DesignerDatabase: Migrating - adding suggested_default column');
                this.db.run(`ALTER TABLE design_decisions ADD COLUMN suggested_default TEXT`);
                this.dirty = true;
            }
        }

        // Migration 2: Recreate plan_items table with new agent-driven schema
        const planItemsInfo = this.db.exec('PRAGMA table_info(plan_items)');
        if (planItemsInfo.length > 0) {
            const tables = this.db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='plan_items'");
            if (tables.length > 0 && tables[0].values.length > 0) {
                const createSql = tables[0].values[0][0] as string;
                
                // Check if using old artifact-based type constraint instead of new action-based
                if (createSql && (createSql.includes("'playbook'") || !createSql.includes("'scaffold'"))) {
                    console.log('DesignerDatabase: Migrating - updating plan_items to agent-driven schema');
                    
                    this.db.run('PRAGMA foreign_keys = OFF');
                    
                    // Create new table with agent-driven schema
                    this.db.run(`
                        CREATE TABLE IF NOT EXISTS plan_items_new (
                            id TEXT PRIMARY KEY CHECK (id GLOB 'ITEM-[0-9][0-9][0-9]' OR id GLOB 'COLL-*'),
                            requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,
                            type TEXT NOT NULL 
                                CHECK (type IN ('scaffold', 'generate', 'install', 'configure')),
                            name TEXT NOT NULL,
                            description TEXT,
                            collection TEXT,
                            collection_rationale TEXT,
                            status TEXT NOT NULL DEFAULT 'proposed'
                                CHECK (status IN ('proposed', 'needs_clarification', 'revised', 'approved', 'rejected', 'in_progress', 'complete', 'failed')),
                            sequence INTEGER,
                            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                    `);
                    
                    // Copy data - map old artifact types to 'generate' action
                    this.db.run(`
                        INSERT INTO plan_items_new 
                        SELECT id, requirement_id, 'generate', name, description, collection, 
                               collection_rationale, 
                               CASE WHEN status = 'pending' THEN 'proposed' ELSE status END,
                               sequence, created_at
                        FROM plan_items
                    `);
                    
                    this.db.run('DROP TABLE plan_items');
                    this.db.run('ALTER TABLE plan_items_new RENAME TO plan_items');
                    
                    this.db.run('PRAGMA foreign_keys = ON');
                    this.dirty = true;
                }
            }
            
            // Check if plan_item_history table exists
            const historyTables = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_item_history'");
            if (historyTables.length === 0 || historyTables[0].values.length === 0) {
                console.log('DesignerDatabase: Migrating - creating plan_item_history table');
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS plan_item_history (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        plan_item_id TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
                        version INTEGER NOT NULL,
                        entry_type TEXT NOT NULL 
                            CHECK (entry_type IN ('proposed', 'comment', 'revised', 'approved', 'rejected')),
                        content TEXT NOT NULL,
                        by TEXT NOT NULL CHECK (by IN ('agent', 'user')),
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                this.dirty = true;
            }
        }

        // Migration 3: Drop priority column and requirement_artifacts table
        // Note: SQLite doesn't support DROP COLUMN easily, so we recreate the table
        const reqInfo = this.db.exec('PRAGMA table_info(requirements)');
        if (reqInfo.length > 0) {
            const columns = reqInfo[0].values.map(row => row[1] as string);
            if (columns.includes('priority')) {
                console.log('DesignerDatabase: Migrating - removing priority column from requirements');
                
                this.db.run('PRAGMA foreign_keys = OFF');
                
                // Create new requirements table without priority
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS requirements_new (
                        id TEXT PRIMARY KEY CHECK (id GLOB 'REQ-[0-9][0-9][0-9]' OR id GLOB 'SYS-[0-9][0-9][0-9]'),
                        description TEXT NOT NULL CHECK (length(description) >= 20),
                        status TEXT NOT NULL DEFAULT 'draft' 
                            CHECK (status IN ('draft', 'assessed', 'planned', 'building', 'complete')),
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        created_by TEXT,
                        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Copy data (without priority)
                this.db.run(`
                    INSERT INTO requirements_new (id, description, status, created_at, created_by, updated_at)
                    SELECT id, description, status, created_at, created_by, updated_at
                    FROM requirements
                `);
                
                this.db.run('DROP TABLE requirements');
                this.db.run('ALTER TABLE requirements_new RENAME TO requirements');
                
                // Drop the requirement_artifacts table (agent determines what to build)
                this.db.run('DROP TABLE IF EXISTS requirement_artifacts');
                
                this.db.run('PRAGMA foreign_keys = ON');
                this.dirty = true;
            }
        }

        // Migration 4: Two-phase assessment support
        // Add assessment_stage to project table
        const projectInfo = this.db.exec('PRAGMA table_info(project)');
        if (projectInfo.length > 0) {
            const projectColumns = projectInfo[0].values.map(row => row[1] as string);
            if (!projectColumns.includes('assessment_stage')) {
                console.log('DesignerDatabase: Migrating - adding assessment_stage column to project');
                this.db.run(`ALTER TABLE project ADD COLUMN assessment_stage TEXT DEFAULT 'dependencies'`);
                this.dirty = true;
            }
        }

        // Add stage column to design_decisions table
        const ddInfo = this.db.exec('PRAGMA table_info(design_decisions)');
        if (ddInfo.length > 0) {
            const ddColumns = ddInfo[0].values.map(row => row[1] as string);
            if (!ddColumns.includes('stage')) {
                console.log('DesignerDatabase: Migrating - adding stage column to design_decisions');
                this.db.run(`ALTER TABLE design_decisions ADD COLUMN stage TEXT DEFAULT 'content'`);
                this.dirty = true;
            }
        }

        // Create identified_collections table
        const collTables = this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='identified_collections'");
        if (collTables.length === 0 || collTables[0].values.length === 0) {
            console.log('DesignerDatabase: Migrating - creating identified_collections table');
            this.db.run(`
                CREATE TABLE IF NOT EXISTS identified_collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,
                    collection_fqcn TEXT NOT NULL,
                    reason TEXT,
                    confirmed BOOLEAN DEFAULT FALSE,
                    installed BOOLEAN DEFAULT FALSE,
                    installed_at DATETIME,
                    UNIQUE (collection_fqcn)
                )
            `);
            this.dirty = true;
        }

        // Migration 5: Update requirements table to allow SYS-* IDs
        const reqTableInfo = this.db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='requirements'");
        if (reqTableInfo.length > 0 && reqTableInfo[0].values.length > 0) {
            const createSql = reqTableInfo[0].values[0][0] as string;
            // Check if table doesn't allow SYS-* pattern yet
            if (createSql && !createSql.includes('SYS-')) {
                console.log('DesignerDatabase: Migrating - updating requirements to allow SYS-* IDs');
                
                this.db.run('PRAGMA foreign_keys = OFF');
                
                // Recreate requirements table with updated constraint
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS requirements_new (
                        id TEXT PRIMARY KEY CHECK (id GLOB 'REQ-[0-9][0-9][0-9]' OR id GLOB 'SYS-[0-9][0-9][0-9]'),
                        description TEXT NOT NULL CHECK (length(description) >= 20),
                        status TEXT NOT NULL DEFAULT 'draft' 
                            CHECK (status IN ('draft', 'assessed', 'planned', 'building', 'complete')),
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        created_by TEXT,
                        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Copy existing data
                this.db.run(`
                    INSERT INTO requirements_new (id, description, status, created_at, created_by, updated_at)
                    SELECT id, description, status, created_at, created_by, updated_at
                    FROM requirements
                `);
                
                this.db.run('DROP TABLE requirements');
                this.db.run('ALTER TABLE requirements_new RENAME TO requirements');
                
                this.db.run('PRAGMA foreign_keys = ON');
                this.dirty = true;
            }
        }

        if (this.dirty) {
            this._save();
            console.log('DesignerDatabase: Migrations applied successfully');
        }
    }

    /**
     * Log an action to the history table
     */
    private _logHistory(
        action: string,
        entityType: string,
        entityId?: string,
        actor?: string,
        details?: Record<string, unknown>
    ): void {
        if (!this.db) {
            return;
        }

        try {
            this.db.run(
                `INSERT INTO history (action, entity_type, entity_id, actor, details)
                 VALUES (?, ?, ?, ?, ?)`,
                [action, entityType, entityId || null, actor || null, details ? JSON.stringify(details) : null]
            );
            this.dirty = true;
            
            // Only auto-save if not in a transaction
            if (!this.inTransaction) {
                this._save();
            }
        } catch {
            // Don't throw on logging failure
        }
    }

    /**
     * Add a history entry (public method for services)
     */
    public logHistory(
        action: string,
        entityType: string,
        entityId?: string,
        actor?: string,
        details?: Record<string, unknown>
    ): void {
        this._logHistory(action, entityType, entityId, actor, details);
    }

    /**
     * Get recent history entries
     */
    public getHistory(limit: number = 50): HistoryEntry[] {
        if (!this.db) {
            return [];
        }

        const result = this.db.exec(`
            SELECT * FROM history 
            ORDER BY timestamp DESC 
            LIMIT ${limit}
        `);

        if (result.length === 0) {
            return [];
        }

        const columns = result[0].columns;
        return result[0].values.map(row => {
            const obj: Record<string, unknown> = {};
            columns.forEach((col, idx) => {
                obj[col] = row[idx];
            });
            return obj as unknown as HistoryEntry;
        });
    }

    // ========================================================================
    // Convenience Methods
    // ========================================================================

    /**
     * Run a single SQL statement (for services)
     */
    public run(sql: string, ...params: unknown[]): RunResult {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        // sql.js doesn't accept undefined, convert to null
        const sanitizedParams = params.map(p => p === undefined ? null : p);
        this.db.run(sql, sanitizedParams as SqlValue[]);
        this.dirty = true;
        
        // Only auto-save if not in a transaction
        if (!this.inTransaction) {
            this._save();
        }
        
        // Get last insert rowid and changes
        const lastId = this.db.exec('SELECT last_insert_rowid()');
        const changes = this.db.exec('SELECT changes()');
        
        return {
            changes: changes.length > 0 ? (changes[0].values[0][0] as number) : 0,
            lastInsertRowid: lastId.length > 0 ? (lastId[0].values[0][0] as number) : 0
        };
    }

    /**
     * Get a single row (for services)
     */
    public get<T>(sql: string, ...params: unknown[]): T | undefined {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        // sql.js doesn't accept undefined, convert to null
        const sanitizedParams = params.map(p => p === undefined ? null : p);
        const result = this.db.exec(sql, sanitizedParams as SqlValue[]);
        
        if (result.length === 0 || result[0].values.length === 0) {
            return undefined;
        }

        const columns = result[0].columns;
        const row = result[0].values[0];
        const obj: Record<string, unknown> = {};
        columns.forEach((col, idx) => {
            obj[col] = row[idx];
        });
        return obj as T;
    }

    /**
     * Get all rows (for services)
     */
    public all<T>(sql: string, ...params: unknown[]): T[] {
        if (!this.db) {
            throw new Error('Database not initialized');
        }

        // sql.js doesn't accept undefined, convert to null
        const sanitizedParams = params.map(p => p === undefined ? null : p);
        const result = this.db.exec(sql, sanitizedParams as SqlValue[]);
        
        if (result.length === 0) {
            return [];
        }

        const columns = result[0].columns;
        return result[0].values.map(row => {
            const obj: Record<string, unknown> = {};
            columns.forEach((col, idx) => {
                obj[col] = row[idx];
            });
            return obj as T;
        });
    }

    /**
     * Execute raw SQL (for schema operations)
     */
    public exec(sql: string): void {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        this.db.run(sql);
        this.dirty = true;
        
        // Only auto-save if not in a transaction
        if (!this.inTransaction) {
            this._save();
        }
    }

    /**
     * Run multiple operations in a transaction
     */
    public transaction<T>(fn: () => T): T {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        
        // Support nested transactions via savepoints
        if (this.inTransaction) {
            // Already in a transaction - just run the function directly
            // The outer transaction will handle commit/rollback
            return fn();
        }
        
        this.inTransaction = true;
        this.db.run('BEGIN TRANSACTION');
        try {
            const result = fn();
            this.db.run('COMMIT');
            this.inTransaction = false;
            this.dirty = true;
            this._save();
            return result;
        } catch (error) {
            try {
                this.db.run('ROLLBACK');
            } catch {
                // Ignore rollback errors if transaction already ended
            }
            this.inTransaction = false;
            throw error;
        }
    }
}

/**
 * Column info from PRAGMA table_info
 */
export interface ColumnInfo {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
}
