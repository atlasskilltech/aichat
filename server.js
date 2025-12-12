const express = require('express');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
// const testRoutes = require('./routes/test');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'hr-chatbot-secret-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        secure: false
    }
}));

// Static files
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// API Routes
app.use('/api', chatRoutes);
app.use('/api/admin', adminRoutes);
// app.use('/api/test', testRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'HR Chatbot API is running',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║   🤖 HR CHATBOT - NODE.JS + EXPRESS          ║
║                                               ║
║   Status:      ✅ Running                    ║
║   Port:        ${PORT}                           ║
║   URL:         http://localhost:${PORT}          ║
║   API:         http://localhost:${PORT}/api      ║
║   Health:      http://localhost:${PORT}/api/health║
║                                               ║
║   Environment: ${process.env.NODE_ENV || 'development'}                    ║
║   Model:       ${process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022'}       ║
╚═══════════════════════════════════════════════╝
    `);
});

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully...');
    process.exit(0);
});