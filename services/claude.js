const axios = require('axios');
require('dotenv').config();

class ClaudeService {
    constructor() {
        this.apiKey = process.env.CLAUDE_API_KEY;
        this.model = process.env.CLAUDE_MODEL;
        this.maxTokens = parseInt(process.env.CLAUDE_MAX_TOKENS);
        this.apiUrl = 'https://api.anthropic.com/v1/messages';
    }

    async ask(messages, systemPrompt = '') {
        try {
            const requestData = {
                model: this.model,
                max_tokens: this.maxTokens,
                messages: messages
            };

            if (systemPrompt) {
                requestData.system = systemPrompt;
            }

            const response = await axios.post(this.apiUrl, requestData, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                timeout: 30000
            });

            return {
                success: true,
                text: response.data.content[0].text
            };

        } catch (error) {
            console.error('Claude API Error:', error.message);

            if (error.response) {
                return {
                    error: `API Error (${error.response.status}): ${error.response.data.error?.message || 'Unknown error'}`
                };
            }

            return {
                error: error.message
            };
        }
    }
}

module.exports = new ClaudeService();