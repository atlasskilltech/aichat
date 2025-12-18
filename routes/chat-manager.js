const express = require('express');
const router = express.Router();
const claude = require('../services/claude');
const db = require('../services/database');

router.post('/manager', async (req, res) => {
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

        // ============================================
        // STEP 1: CHECK FOR POLICY QUESTION FIRST!
        // (Before calling Claude API)
        // ============================================
        
        const policyCheck = checkPolicyQuestion(message);
        
        if (policyCheck.isPolicy) {
            console.log(`📚 Policy question detected: ${policyCheck.reason}`);
            console.log('📚 Searching HR Policy Handbook...');
            
            const policyResults = await db.searchHRPolicy(message);
            
            if (policyResults.length > 0) {
                console.log(`✅ Found ${policyResults.length} relevant sections in HR Handbook`);
                
                // Build context from policy
                let policyContext = '=== ATLAS SKILLTECH UNIVERSITY HR HANDBOOK ===\n\n';
                
                policyResults.forEach((result, index) => {
                    policyContext += `Section ${index + 1}`;
                    if (result.page_number) {
                        policyContext += ` (Page ${result.page_number})`;
                    }
                    policyContext += `:\n${result.content}\n\n`;
                });
                
                // Ask Claude to answer from policy
                const policyMessages = [{
                    role: 'user',
                    content: `Answer this question based on the Atlas SkillTech University HR Handbook:

Question: "${message}"

${policyContext}

Instructions:
- Answer based ONLY on the HR handbook content provided above
- Be specific and reference the section/page when relevant
- If the handbook doesn't cover this topic, say so clearly
- Keep answer clear, concise, and professional
- Use bullet points for lists or multiple items
- Be helpful and friendly`
                }];
                
                console.log('🤖 Getting answer from HR Handbook...');
                const policyResponse = await claude.ask(
                    policyMessages, 
                    'You are an HR assistant for Atlas SkillTech University. Answer based on the provided handbook content.'
                );
                
                const policyAnswer = policyResponse.error 
                    ? 'Error retrieving policy information' 
                    : policyResponse.text;
                
                console.log('✅ Policy answer received');
                
                // Save to chat logs
                await db.saveChat(
                    req.session.chatId, 
                    message, 
                    policyAnswer, 
                    null
                );
                
                // Return policy-based answer
                return res.json({
                    success: true,
                    response: policyAnswer,
                    isPolicyAnswer: true,
                    source: '📄 Atlas SkillTech HR Handbook',
                    policyPages: policyResults.map(r => r.page_number).filter(p => p)
                });
            } else {
                console.log('⚠️ No relevant policy content found in handbook');
                // Fall through to normal Claude processing
            }
        } else {
            console.log(`🔍 Not a policy question: ${policyCheck.reason}`);
        }

        // ============================================
        // STEP 2: NORMAL PROCESSING (Database queries)
        // ============================================

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

// ============================================
// HELPER FUNCTION: CHECK POLICY QUESTION
// This runs BEFORE calling Claude API
// ============================================

function checkPolicyQuestion(message) {
    const lowerMsg = message.toLowerCase();
    
    // EXPLICIT POLICY KEYWORDS - these are clearly policy questions
    const explicitPolicyKeywords = [
        'leave policy',
        'attendance policy', 
        'dress code policy',
        'dress code',
        'code of conduct',
        'probation policy',
        'confirmation policy',
        'appraisal policy',
        'performance policy',
        'review policy',
        'travel policy',
        'benefits policy',
        'welfare policy',
        'employee handbook',
        'hr handbook',
        'hr policy',
        'company policy',
        'work from home policy',
        'wfh policy',
        'holiday policy',
        'salary policy',
        'increment policy',
        'bonus policy',
        'grievance policy',
        'separation policy',
        'retirement policy',
        'notice period policy',
        'notice period policy'
    ];
    
    // Check explicit keywords first
    for (const keyword of explicitPolicyKeywords) {
        if (lowerMsg.includes(keyword)) {
            return {
                isPolicy: true,
                reason: `Contains explicit policy keyword: "${keyword}"`
            };
        }
    }
    
    // POLICY QUESTION PHRASES
    const policyPhrases = [
        'what is the policy',
        'what are the rules',
        'what is the procedure',
        'what are the procedures',
        'explain the policy',
        'tell me about the policy',
        'what are the guidelines',
        'how does the policy work',
        'policy regarding',
        'rules regarding',
        'rules for',
        'guidelines for',
        'procedure for',
        'what are my benefits',
        'what benefits do i get',
        'what benefits am i entitled',
        'how many days of leave am i entitled',
        'how many days of leave do i get',
        'how many days of leave can i',
        'what is my leave entitlement',
        'am i allowed to',
        'can i take',
        'what is the notice period',
        'what is the probation period',
        'how long is probation',
        'how long is notice period'
    ];
    
    // Check policy phrases
    for (const phrase of policyPhrases) {
        if (lowerMsg.includes(phrase)) {
            return {
                isPolicy: true,
                reason: `Contains policy phrase: "${phrase}"`
            };
        }
    }
    
    // DATA REQUEST INDICATORS - these mean it's NOT a policy question
    const dataIndicators = [
        'show me',
        'display',
        'list all',
        'list the',
        'get me',
        'find',
        'search for',
        'report for',
        'report of',
        "'s report", // possessive + report
        "'s leave", // possessive + leave
        "'s attendance",
        "'s details",
        "'s records",
        "'s history",
        'how many employees',
        'how many staff',
        'count of',
        'total number',
        'who took',
        'who has',
        'which employees',
        'employees who',
        'staff who'
    ];
    
    // If contains data indicators, it's NOT policy
    for (const indicator of dataIndicators) {
        if (lowerMsg.includes(indicator)) {
            return {
                isPolicy: false,
                reason: `Contains data indicator: "${indicator}"`
            };
        }
    }
    
    // Default: not a policy question
    return {
        isPolicy: false,
        reason: 'No policy keywords or phrases detected'
    };
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