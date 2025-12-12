const express = require('express');
const router = express.Router();
const claude = require('../services/claude');
const db = require('../services/database');

router.post('/chat', async (req, res) => {
    try {
        const { message, history = [] } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'Message is required' 
            });
        }

        // Initialize session
        if (!req.session.chatId) {
            req.session.chatId = 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        // Initialize conversation context in session
        if (!req.session.conversationContext) {
            req.session.conversationContext = {
                previousQueries: [],
                previousResults: [],
                topics: [],
                userPreferences: {}
            };
        }

        console.log('📨 New message:', message);
        console.log('🆔 Session:', req.session.chatId);

        // Get enhanced schema with context
        const schemaContext = await db.getEnhancedSchema();

        // Build conversation messages with history
        const messages = [];

        // Add recent history (last 6 messages for context)
        const recentHistory = history.slice(-6);
        
        if (recentHistory.length > 0) {
            console.log(`📚 Including ${recentHistory.length} previous messages for context`);
            messages.push(...recentHistory);
        }

        // Add previous queries context (if any)
        const previousQueriesContext = req.session.conversationContext.previousQueries
            .slice(-3)
            .map(q => `Previous query: "${q.question}" → Result: ${q.rowCount} rows`)
            .join('\n');

        // Build enhanced user message with context
        let enhancedMessage = message.trim();
        
        if (previousQueriesContext) {
            enhancedMessage = `Context from conversation:\n${previousQueriesContext}\n\nCurrent question: ${message}`;
        }

        messages.push({
            role: 'user',
            content: enhancedMessage
        });

        // ENHANCED SYSTEM PROMPT with more context
        const systemPrompt = `${schemaContext}

=== YOUR ROLE ===
You are an intelligent HR database assistant with memory of the conversation.

=== RESPONSE RULES ===

If user needs DATABASE DATA:
→ Return ONLY: {"sql":"SELECT statement"}
→ Consider previous conversation context
→ Use appropriate JOINs based on relationships
→ Apply filters intelligently

If user asks GENERAL QUESTION or FOLLOWUP:
→ Return helpful text answer
→ Use context from previous queries

=== IMPORTANT CONTEXT HANDLING ===

1. If user says "show more", "tell me more", "what about..." → Check previous context
2. If user refers to previous results → Use that context
3. If user asks followup questions → Build on previous query
4. Use proper column names and relationships from schema

=== QUERY BEST PRACTICES ===

1. Use meaningful column aliases (as total_count, as department_name)
2. Join tables when needed for complete information
3. Add WHERE clauses for filtering
4. Use GROUP BY for aggregations
5. Order results logically (ORDER BY)
6. Limit results if needed (but don't by default)

=== EXAMPLES ===

User: "How many employees?"
Response: {"sql":"SELECT COUNT(*) as total_employees FROM dice_staff WHERE staff_status='active'"}

User: "List them"  [referring to previous query]
Response: {"sql":"SELECT staff_first_name, staff_last_name, staff_designation FROM dice_staff WHERE staff_status='active' ORDER BY staff_first_name"}

User: "Show Aamir Khan's details"
Response: {"sql":"SELECT ds.*, dsd.staff_department_name FROM dice_staff ds LEFT JOIN dice_staff_department dsd ON ds.staff_department = dsd.staff_department_id WHERE ds.staff_first_name='Aamir' AND ds.staff_last_name='Khan'"}

User: "What's the leave policy?"
Response: "The standard leave policy typically includes 20 days of annual leave..."

⚠️ CRITICAL: For database queries, return ONLY the JSON!`;

        console.log('🤖 Calling Claude API with enhanced context...');
        const response = await claude.ask(messages, systemPrompt);

        if (response.error) {
            console.error('❌ Claude API Error:', response.error);
            return res.status(500).json({ 
                success: false, 
                error: response.error 
            });
        }

        let answer = response.text.trim();
        console.log('📝 Response received:', answer.substring(0, 200) + '...');

        // Extract JSON with multiple methods
        let jsonData = null;
        let sql = null;

        // Method 1: Direct parse
        try {
            let cleanedAnswer = answer
                .replace(/\n/g, ' ')
                .replace(/\r/g, '')
                .replace(/\t/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            
            if (cleanedAnswer.startsWith('{') && cleanedAnswer.endsWith('}')) {
                jsonData = JSON.parse(cleanedAnswer);
                console.log('✅ Direct JSON parse successful');
            }
        } catch (e) {
            console.log('⚠️ Direct parse failed, trying extraction...');
        }

        // Method 2: Extract from text
        if (!jsonData) {
            const jsonPattern = /\{\s*"sql"\s*:\s*"([^"]*(?:\\"[^"]*)*)"\s*\}/;
            const match = answer.match(jsonPattern);
            
            if (match) {
                try {
                    const jsonString = match[0]
                        .replace(/\n/g, ' ')
                        .replace(/\s+/g, ' ');
                    
                    jsonData = JSON.parse(jsonString);
                    console.log('✅ JSON extracted from text');
                } catch (e) {
                    console.log('⚠️ Extraction failed');
                }
            }
        }

        // Method 3: Aggressive SQL extraction
        if (!jsonData) {
            const sqlPattern = /(?:"sql"\s*:\s*")(SELECT[\s\S]*?)(?:")/i;
            const sqlMatch = answer.match(sqlPattern);
            
            if (sqlMatch && sqlMatch[1]) {
                sql = sqlMatch[1]
                    .replace(/\\n/g, ' ')
                    .replace(/\n/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                
                jsonData = { sql: sql };
                console.log('✅ SQL extracted directly');
            }
        }

        // Execute query if SQL found
        if (jsonData && jsonData.sql && typeof jsonData.sql === 'string') {
            
            sql = jsonData.sql.replace(/\s+/g, ' ').trim();
            
            console.log('🔍 SQL query:', sql.substring(0, 150) + '...');
            console.log('⚙️ Executing query...');
            
            const result = await db.executeQuery(sql);

            if (!result.success || result.error) {
                console.error('❌ Query failed:', result.error);
                
                await db.saveChat(
                    req.session.chatId, 
                    message, 
                    `Query error: ${result.error}`, 
                    sql
                );

                return res.json({
                    success: false,
                    error: `Database error: ${result.error}`,
                    sql: sql
                });
            }

            console.log(`✅ Query executed: ${result.count} rows`);

            // Save query to conversation context
            req.session.conversationContext.previousQueries.push({
                question: message,
                sql: sql,
                rowCount: result.count,
                timestamp: new Date()
            });

            // Keep only last 5 queries
            if (req.session.conversationContext.previousQueries.length > 5) {
                req.session.conversationContext.previousQueries.shift();
            }

            if (result.count === 0) {
                const noResultsMsg = 'No records found matching your criteria.';
                
                await db.saveChat(req.session.chatId, message, noResultsMsg, sql);

                return res.json({
                    success: true,
                    response: noResultsMsg,
                    count: 0,
                    sql: sql
                });
            }

            // Format results with context
            const dataLimited = result.data.slice(0, 15);

            console.log('💬 Formatting results with context...');

            // Build formatting prompt with context
            const formatMessages = [{
                role: 'user',
                content: `Format these database results naturally and professionally:

Original Question: "${message}"

Query Executed: ${sql}

Results (showing ${dataLimited.length} of ${result.count} total):
${JSON.stringify(dataLimited, null, 2)}

Previous Context:
${previousQueriesContext || 'None'}

Instructions:
- Answer the user's original question directly
- Use natural, conversational language
- Format data clearly (use bullet points or tables if helpful)
- If multiple records, show them in an organized way
- Mention total count if showing partial results
- Be concise but informative
- DO NOT include the SQL query in response`
            }];

            const formatResponse = await claude.ask(formatMessages, '');

            let finalAnswer;
            
            if (formatResponse.error) {
                console.log('⚠️ Formatting failed, using fallback');
                finalAnswer = formatFallback(result.data, result.count, message);
            } else {
                finalAnswer = formatResponse.text.trim();
                console.log('✅ Results formatted successfully');
            }

            // Save to context
            req.session.conversationContext.previousResults.push({
                question: message,
                answer: finalAnswer,
                rowCount: result.count
            });

            if (req.session.conversationContext.previousResults.length > 5) {
                req.session.conversationContext.previousResults.shift();
            }

            // Save to database
            await db.saveChat(req.session.chatId, message, finalAnswer, sql);

            return res.json({
                success: true,
                response: finalAnswer,
                count: result.count,
                sql: sql,
                context: {
                    hasHistory: recentHistory.length > 0,
                    previousQueries: req.session.conversationContext.previousQueries.length
                }
            });
        }

        // No query - direct answer
        console.log('💭 Direct answer (no query)');
        
        await db.saveChat(req.session.chatId, message, answer, null);

        return res.json({
            success: true,
            response: answer
        });

    } catch (error) {
        console.error('❌ Error:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Enhanced fallback formatter
function formatFallback(data, totalCount, question) {
    let response = `📊 Results for "${question}":\n\n`;
    response += `Found ${totalCount} record${totalCount !== 1 ? 's' : ''}:\n\n`;

    const dataLimited = data.slice(0, 10);

    dataLimited.forEach((row, index) => {
        response += `${index + 1}. `;
        
        const parts = [];
        for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== '') {
                const readableKey = key
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, c => c.toUpperCase());
                
                parts.push(`${readableKey}: ${value}`);
            }
        }
        
        response += parts.join(' | ') + '\n';
    });

    if (totalCount > 10) {
        response += `\n(Showing first 10 of ${totalCount} total records)`;
    }

    return response;
}

module.exports = router;