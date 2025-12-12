const express = require('express');
const router = express.Router();
const db = require('../services/database');

// Get schema
router.get('/schema', async (req, res) => {
    try {
        const schema = await db.getSchema();
        const tables = await db.getTableList();

        res.json({
            success: true,
            schema: schema,
            tables: tables
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Refresh schema
router.post('/refresh', async (req, res) => {
    try {
        const result = await db.refreshSchema();
        const schema = await db.getSchema();

        res.json({
            success: true,
            message: 'Schema refreshed',
            schema: schema
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;