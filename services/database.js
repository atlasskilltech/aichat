const pool = require('../config/database');

class DatabaseService {

    // Get enhanced schema with more context
    async getEnhancedSchema() {
        try {
            const [tables] = await pool.query(
                'SELECT * FROM db_schema_info ORDER BY table_name'
            );

            if (tables.length === 0) {
                return 'Schema not initialized. Run: CALL update_schema_info();';
            }

            let schema = '=== DATABASE SCHEMA WITH CONTEXT ===\n\n';

            // Add table details with sample data
            for (const table of tables) {
                schema += `TABLE: ${table.table_name}\n`;
                schema += `COLUMNS: ${table.table_columns}\n`;
                
                // Add sample data if available
                if (table.sample_data) {
                    schema += `SAMPLE: ${table.sample_data}\n`;
                }
                
                schema += '\n';
            }

            // Add relationships with descriptions
            const [rels] = await pool.query(
                'SELECT * FROM db_relationships_info'
            );

            if (rels.length > 0) {
                schema += '=== TABLE RELATIONSHIPS ===\n';
                for (const rel of rels) {
                    schema += `${rel.from_table}.${rel.from_column} → `;
                    schema += `${rel.to_table}.${rel.to_column}`;
                    
                    if (rel.relationship_type) {
                        schema += ` (${rel.relationship_type})`;
                    }
                    
                    schema += '\n';
                }
                schema += '\n';
            }

            // Add common column meanings
            schema += `=== COLUMN MEANINGS ===
staff_status: 'active', 'inactive', 'on_leave'
dice_m_status: 1=pending, 2=approved, 3=rejected
staff_department: Foreign key to staff_department_id
staff_designation: Job title/position\n\n`;

            // Add helpful notes
            schema += `=== NOTES ===
- Use JOINs to get related data (e.g., employee with department name)
- Filter active staff with WHERE staff_status='active'
- For aggregations, use COUNT, SUM, AVG with GROUP BY
- Always use meaningful aliases (AS column_name)
- Use ORDER BY for sorted results\n`;

            return schema;

        } catch (error) {
            console.error('❌ Schema Error:', error);
            return 'Error loading database schema';
        }
    }

    // Original getSchema method (keep for compatibility)
    async getSchema() {
        try {
            const [tables] = await pool.query(
                'SELECT * FROM db_schema_info ORDER BY table_name'
            );

            if (tables.length === 0) {
                return 'Schema not initialized.';
            }

            let schema = '=== DATABASE TABLES ===\n\n';

            for (const table of tables) {
                schema += `TABLE: ${table.table_name}\n`;
                schema += `COLUMNS: ${table.table_columns}\n\n`;
            }

            const [rels] = await pool.query(
                'SELECT * FROM db_relationships_info'
            );

            if (rels.length > 0) {
                schema += '=== RELATIONSHIPS ===\n';
                for (const rel of rels) {
                    schema += `${rel.from_table}.${rel.from_column} → `;
                    schema += `${rel.to_table}.${rel.to_column}\n`;
                }
            }

            return schema;

        } catch (error) {
            console.error('❌ Schema Error:', error);
            return 'Error loading schema';
        }
    }

    // Execute safe query
    async executeQuery(sql) {
        try {
            if (!this.isSafeQuery(sql)) {
                return { 
                    success: false, 
                    error: 'Unsafe query detected' 
                };
            }

            const [rows] = await pool.query(sql);

            return {
                success: true,
                count: rows.length,
                data: rows
            };

        } catch (error) {
            console.error('❌ Query Error:', error);
            return { 
                success: false, 
                error: error.message 
            };
        }
    }

    // Validate query safety
    isSafeQuery(sql) {
        const cleanSql = sql
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/--.*/g, '')
            .trim()
            .toUpperCase();

        if (!cleanSql.startsWith('SELECT')) return false;

        const blocked = [
            'DELETE ', 'DROP ', 'INSERT ', 'UPDATE ', 'ALTER ',
            'CREATE ', 'TRUNCATE ', 'RENAME ', 'REPLACE ',
            'EXEC ', 'EXECUTE ', 'HANDLER ', 'LOAD DATA',
            'INTO OUTFILE', 'INTO DUMPFILE', 'LOAD_FILE'
        ];

        return !blocked.some(keyword => cleanSql.includes(keyword));
    }

    // Save chat
    async saveChat(sessionId, userMsg, botResponse, sql = null) {
        try {
            await pool.query(
                `INSERT INTO chat_logs 
                (session_id, message, response, sql_executed, created_at) 
                VALUES (?, ?, ?, ?, NOW())`,
                [sessionId, userMsg, botResponse, sql]
            );

            return true;
        } catch (error) {
            console.error('❌ Save Error:', error);
            return false;
        }
    }

    // Refresh schema
    async refreshSchema() {
        try {
            await pool.query('CALL update_schema_info()');
            return { success: true, message: 'Schema refreshed' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Get table list
    async getTableList() {
        try {
            const [rows] = await pool.query(
                'SELECT table_name FROM db_schema_info ORDER BY table_name'
            );
            return rows.map(r => r.table_name);
        } catch (error) {
            return [];
        }
    }

    // Get conversation statistics
    async getConversationStats(sessionId) {
        try {
            const [stats] = await pool.query(
                `SELECT 
                    COUNT(*) as total_messages,
                    COUNT(CASE WHEN sql_executed IS NOT NULL THEN 1 END) as queries_executed,
                    MIN(created_at) as first_message,
                    MAX(created_at) as last_message
                FROM chat_logs
                WHERE session_id = ?`,
                [sessionId]
            );

            return stats[0] || {};
        } catch (error) {
            console.error('❌ Stats Error:', error);
            return {};
        }
    }

    // ============================================
    // NEW: HR POLICY HANDBOOK SEARCH
    // ============================================
    
    /**
     * Search HR Policy Handbook using FULLTEXT search
     * @param {string} query - User's search query
     * @returns {Array} - Matching policy sections
     */
    async searchHRPolicy(query) {
        try {
            const connection = await this.getConnection();
            
            try {
                // Search using FULLTEXT with natural language mode
                const [results] = await connection.query(
                    `SELECT 
                        id, 
                        page_number, 
                        section_title,
                        content,
                        MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) as relevance
                     FROM hr_policy_content
                     WHERE MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
                     ORDER BY relevance DESC
                     LIMIT 5`,
                    [query, query]
                );

                console.log(`   📚 Found ${results.length} matching sections in HR Handbook`);

                // Log search for analytics
                if (results.length > 0) {
                    await connection.query(
                        `INSERT INTO hr_policy_searches (query, matched_results) 
                         VALUES (?, ?)`,
                        [query, results.length]
                    );
                }

                return results;
                
            } finally {
                connection.release();
            }
        } catch (error) {
            console.error('❌ HR Policy Search Error:', error);
            return [];
        }
    }

    /**
     * Get a connection from the pool
     * @returns {Promise<Connection>} - Database connection
     */
    async getConnection() {
        return await pool.getConnection();
    }

    /**
     * Get HR Policy search statistics
     * @returns {Array} - Top searched queries
     */
    async getHRPolicyStats() {
        try {
            const [stats] = await pool.query(
                `SELECT 
                    query,
                    COUNT(*) as search_count,
                    AVG(matched_results) as avg_results,
                    MAX(created_at) as last_searched
                 FROM hr_policy_searches
                 GROUP BY query
                 ORDER BY search_count DESC
                 LIMIT 10`
            );

            return stats;
        } catch (error) {
            console.error('❌ Policy Stats Error:', error);
            return [];
        }
    }

    /**
     * Check if HR Policy content is loaded
     * @returns {Object} - Status and count
     */
    async checkHRPolicyStatus() {
        try {
            const [result] = await pool.query(
                `SELECT 
                    COUNT(*) as total_chunks,
                    SUM(content_length) as total_characters,
                    MAX(page_number) as max_page
                 FROM hr_policy_content`
            );

            const isLoaded = result[0].total_chunks > 0;

            return {
                loaded: isLoaded,
                chunks: result[0].total_chunks,
                characters: result[0].total_characters,
                pages: result[0].max_page
            };
        } catch (error) {
            console.error('❌ Policy Status Error:', error);
            return {
                loaded: false,
                error: error.message
            };
        }
    }
}

module.exports = new DatabaseService();