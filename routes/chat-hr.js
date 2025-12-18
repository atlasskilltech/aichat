const express = require('express');
const router = express.Router();
const claude = require('../services/claude');
const db = require('../services/database');

// ============================================
// HR CHAT ROUTE
// HR has FULL ACCESS to all data + HR policies
// ============================================

router.post('/chat/hr', async (req, res) => {
    try {
        const { message, history = [], hrId, hrEmail } = req.body;

        // Validation
        if (!message || !message.trim()) {
            return res.status(400).json({ 
                success: false, 
                error: 'Message is required' 
            });
        }

        if (!hrId && !hrEmail) {
            return res.status(400).json({ 
                success: false, 
                error: 'HR ID or Email is required for authentication' 
            });
        }

        // Initialize session
        if (!req.session.chatId) {
            req.session.chatId = 'chat_hr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        if (!req.session.conversationContext) {
            req.session.conversationContext = {
                previousQueries: [],
                previousResults: [],
                topics: [],
                userPreferences: {},
                role: 'hr',
                hrId: hrId,
                hrEmail: hrEmail
            };
        }

        console.log('🏢 HR Chat:', message);
        console.log('🆔 HR ID:', hrId);
        console.log('✅ Access Level: FULL ACCESS');

        // ============================================
        // STEP 1: CHECK FOR POLICY QUESTION
        // ============================================
        
        const policyCheck = checkPolicyQuestion(message);
        
        if (policyCheck.isPolicy) {
            console.log('📚 Policy question detected');
            
            const policyResults = await db.searchHRPolicy(message);
            
            if (policyResults.length > 0) {
                console.log(`✅ Found ${policyResults.length} sections in HR Handbook`);
                
                let policyContext = '=== ATLAS SKILLTECH UNIVERSITY HR HANDBOOK ===\n\n';
                
                policyResults.forEach((result, index) => {
                    policyContext += `Section ${index + 1}`;
                    if (result.page_number) {
                        policyContext += ` (Page ${result.page_number})`;
                    }
                    policyContext += `:\n${result.content}\n\n`;
                });
                
                const policyMessages = [{
                    role: 'user',
                    content: `Answer this question based on the Atlas SkillTech University HR Handbook:

Question: "${message}"

${policyContext}

Instructions:
- Answer based ONLY on the HR handbook content provided
- Be specific and reference sections/pages
- Keep answer clear and professional
- Use bullet points for lists`
                }];
                
                const policyResponse = await claude.ask(
                    policyMessages, 
                    'You are an HR assistant. Answer based on the handbook.'
                );
                
                const policyAnswer = policyResponse.error 
                    ? 'Error retrieving policy information' 
                    : policyResponse.text;
                
                await db.saveChat(req.session.chatId, message, policyAnswer, null);
                
                return res.json({
                    success: true,
                    response: policyAnswer,
                    isPolicyAnswer: true,
                    source: '📄 Atlas SkillTech HR Handbook',
                    accessLevel: 'hr'
                });
            }
        }

        // ============================================
        // STEP 2: PROCESS DATA QUERIES (FULL ACCESS)
        // ============================================

        const schemaContext = await db.getEnhancedSchema();
        const messages = [];
        const recentHistory = history.slice(-6);
        
        if (recentHistory.length > 0) {
            console.log(`📚 Including ${recentHistory.length} previous messages`);
            messages.push(...recentHistory);
        }

        const previousQueriesContext = req.session.conversationContext.previousQueries
            .slice(-3)
            .map(q => `Previous query: "${q.question}" → Result: ${q.rowCount} rows`)
            .join('\n');

        let enhancedMessage = message.trim();
        if (previousQueriesContext) {
            enhancedMessage = `Context from conversation:\n${previousQueriesContext}\n\nCurrent question: ${message}`;
        }

        messages.push({
            role: 'user',
            content: enhancedMessage
        });

        // HR-SPECIFIC SYSTEM PROMPT (FULL ACCESS)
        const systemPrompt = `${schemaContext}

=== YOUR ROLE ===
You are an HR database assistant for HR PERSONNEL with FULL ACCESS.

=== ACCESS PERMISSIONS ===
✅ HR ID: ${hrId}
✅ Access Level: FULL ACCESS TO ALL DATA
✅ Can view: ALL staff members, ALL departments, ALL records
✅ No restrictions on data access

=== RESPONSE RULES ===

If user needs DATABASE DATA:
→ Return ONLY: {"sql":"SELECT statement"}
→ Consider previous conversation context
→ Use appropriate JOINs based on relationships
→ Apply filters intelligently
→ NO ACCESS RESTRICTIONS - HR can see everything

=== IMPORTANT CONTEXT HANDLING ===

1. If user says "show more", "tell me more" → Check previous context
2. If user refers to previous results → Use that context
3. If user asks followup questions → Build on previous query
4. Use proper column names and relationships from schema

=== QUERY BEST PRACTICES ===

1. Use meaningful column aliases (as total_count, as department_name)
2. Join tables when needed for complete information
3. Add WHERE clauses for filtering (but no access restrictions)
4. Use GROUP BY for aggregations
5. Order results logically (ORDER BY)
6. Limit results if needed (but don't by default)

=== EXAMPLES ===

User: "How many employees?"
Response: {"sql":"SELECT COUNT(*) as total_employees FROM dice_staff WHERE staff_status='active'"}

User: "Show Aamir's leave records"
Response: {"sql":"SELECT dsl.*, ds.staff_first_name, ds.staff_last_name FROM dice_staff_leave dsl LEFT JOIN dice_staff ds ON dsl.staff_id = ds.staff_id WHERE ds.staff_first_name='Aamir' ORDER BY dsl.staff_leave_start_date DESC"}

User: "Department wise attendance summary"
Response: {"sql":"SELECT dsd.staff_department_name, COUNT(dsa.id) as attendance_count, COUNT(DISTINCT dsa.staff_id) as unique_staff FROM dice_staff_attendance dsa LEFT JOIN dice_staff ds ON dsa.staff_id = ds.staff_id LEFT JOIN dice_staff_department dsd ON ds.staff_department = dsd.staff_department_id GROUP BY dsd.staff_department_name ORDER BY attendance_count DESC"}

User: "All pending leave requests"
Response: {"sql":"SELECT dsl.*, ds.staff_first_name, ds.staff_last_name, ds.staff_email FROM dice_staff_leave dsl LEFT JOIN dice_staff ds ON dsl.staff_id = ds.staff_id WHERE dsl.staff_leave_status = 'pending' ORDER BY dsl.created_at DESC"}

⚠️ CRITICAL: For database queries, return ONLY the JSON!`;

        console.log('🤖 Calling Claude API (HR Full Access)...');
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
            
            console.log('🔍 HR SQL:', sql.substring(0, 150) + '...');
            console.log('⚙️ Executing query (Full Access)...');
            
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
                    sql: sql,
                    accessLevel: 'hr'
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
                accessLevel: 'hr',
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
            response: answer,
            accessLevel: 'hr'
        });

    } catch (error) {
        console.error('❌ HR Chat Error:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Helper functions
function checkPolicyQuestion(message) {
    const lowerMsg = message.toLowerCase();
    
    const explicitPolicyKeywords = [
        'leave policy', 'attendance policy', 'dress code', 'code of conduct',
        'probation policy', 'appraisal policy', 'performance policy',
        'travel policy', 'benefits policy', 'employee handbook', 'hr handbook'
    ];
    
    for (const keyword of explicitPolicyKeywords) {
        if (lowerMsg.includes(keyword)) {
            return { isPolicy: true, reason: keyword };
        }
    }
    
    const policyPhrases = [
        'what is the policy', 'what are the rules', 'explain the policy',
        'what are my benefits', 'how many days of leave do i get'
    ];
    
    for (const phrase of policyPhrases) {
        if (lowerMsg.includes(phrase)) {
            return { isPolicy: true, reason: phrase };
        }
    }
    
    return { isPolicy: false };
}

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