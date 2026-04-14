/**
 * UZHIYA Dashboard — Backend API Server
 * Connects to: crossover.proxy.rlwy.net:17234 (Railway PostgreSQL)
 * Database: railway
 * Run: node server.js
 * Port: 3001
 */
require('dotenv').config();

const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;
const BOT  = process.env.BOT_NAME || 'solita_whatsapp';

// ─────────────────────────────────────────────
// PostgreSQL Connection — crossover Railway
// ─────────────────────────────────────────────
// Option A (recommended): set DATABASE_URL in .env as full connection string
//   DATABASE_URL=postgresql://postgres:PASSWORD@crossover.proxy.rlwy.net:17234/railway
//
// Option B: set individual PG_HOST / PG_PORT / PG_DB / PG_USER / PG_PASS in .env

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host:     process.env.PG_HOST || 'crossover.proxy.rlwy.net',
      port:     parseInt(process.env.PG_PORT || '17234'),
      database: process.env.PG_DB   || 'railway',
      user:     process.env.PG_USER || 'postgres',
      password: String(process.env.PG_PASS || ''),
      ssl:      { rejectUnauthorized: false },
    };

const pool = new Pool({
  ...poolConfig,
  max:                     10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve uzhiya.html at root — place uzhiya.html in the same folder as server.js
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'uzhiya.html'));
});

// Simple request logger
app.use((req, res, next) => {
  const ts = new Date().toLocaleTimeString('id-ID', { hour12: false });
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', db: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/bot-limit
// Returns current bot_limit row for BOT_NAME
// ─────────────────────────────────────────────
app.get('/api/bot-limit', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT bot, limit_usd, bot_active, current_cost, updated_at
       FROM   public.bot_limit
       WHERE  bot = $1`,
      [BOT]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Bot "${BOT}" not found in bot_limit table` });
    }

    const row = result.rows[0];
    res.json({
      bot:          row.bot,
      limit:        parseFloat(row.limit_usd),
      bot_active:   row.bot_active,
      current_cost: parseFloat(row.current_cost),
      updated_at:   row.updated_at,
    });
  } catch (err) {
    console.error('GET /api/bot-limit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/bot-limit
// Body: { limit: 30 }
// Updates limit — auto-reactivates bot if cost < new limit
// ─────────────────────────────────────────────
app.post('/api/bot-limit', async (req, res) => {
  const { limit } = req.body;
  if (!limit || isNaN(parseFloat(limit)) || parseFloat(limit) <= 0) {
    return res.status(400).json({ error: 'Invalid limit value' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM public.set_bot_limit($1, $2)`,
      [BOT, parseFloat(limit)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Bot "${BOT}" not found` });
    }

    const row = result.rows[0];
    res.json({
      success:      true,
      bot:          row.bot,
      limit:        parseFloat(row.limit_usd),
      bot_active:   row.bot_active,
      current_cost: parseFloat(row.current_cost),
      updated_at:   row.updated_at,
    });
  } catch (err) {
    console.error('POST /api/bot-limit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/bot-status
// Body: { bot: true|false }
// Manually enable/disable bot
// ─────────────────────────────────────────────
app.post('/api/bot-status', async (req, res) => {
  const { bot } = req.body;
  if (typeof bot !== 'boolean') {
    return res.status(400).json({ error: 'Field "bot" must be a boolean' });
  }

  try {
    const result = await pool.query(
      `UPDATE public.bot_limit
       SET    bot_active = $1,
              updated_at = NOW()
       WHERE  bot = $2
       RETURNING bot, limit_usd, bot_active, current_cost, updated_at`,
      [bot, BOT]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Bot "${BOT}" not found` });
    }

    const row = result.rows[0];
    res.json({
      success:    true,
      bot_active: row.bot_active,
      updated_at: row.updated_at,
    });
  } catch (err) {
    console.error('POST /api/bot-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/refresh-cost
// Trigger refresh_bot_cost() — call from n8n after each message
// ─────────────────────────────────────────────
app.post('/api/refresh-cost', async (req, res) => {
  try {
    await pool.query(`SELECT public.refresh_bot_cost($1)`, [BOT]);
    const result = await pool.query(
      `SELECT current_cost, bot_active FROM public.bot_limit WHERE bot = $1`,
      [BOT]
    );
    const row = result.rows[0] || {};
    res.json({
      success:      true,
      current_cost: parseFloat(row.current_cost || 0),
      bot_active:   row.bot_active,
    });
  } catch (err) {
    console.error('POST /api/refresh-cost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/token-tracker
// All token_tracker data — used by dashboard
// ─────────────────────────────────────────────
app.get('/api/token-tracker', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
          session_id,
          action,
          chat_input,
          output,
          execution_id,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          global_cost,
          model_name,
          created_at
       FROM  llm.token_tracker
       ORDER BY created_at DESC
       LIMIT 5000`  // cap to keep response manageable
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('GET /api/token-tracker error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────
// GET /api/user-names
// Join session_id → name from auth_soltius table
// Used by dashboard to show real names instead of phone numbers
// ─────────────────────────────────────────────
app.get('/api/user-names', async (req, res) => {
  try {
    // Join llm.token_tracker sessions with "SOLTIUS".auth_users
    // auth_users: nomor_hp (matches session_id), nama, jabatan
    const result = await pool.query(`
      SELECT DISTINCT
        tt.session_id,
        COALESCE(au.nama, tt.session_id) AS nama,
        au.jabatan
      FROM llm.token_tracker tt
      LEFT JOIN "SOLTIUS".auth_users au
        ON au.nomor_hp = tt.session_id
      WHERE tt.session_id IS NOT NULL
      ORDER BY tt.session_id
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    // Fallback: return session_ids only
    try {
      const fallback = await pool.query(
        `SELECT DISTINCT session_id, session_id AS nama FROM llm.token_tracker WHERE session_id IS NOT NULL`
      );
      res.json({ success: true, data: fallback.rows });
    } catch (err2) {
      console.error('GET /api/user-names error:', err2.message);
      res.status(500).json({ error: err2.message });
    }
  }
});

// ─────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// Validates against public.dashboard_users
// ─────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const result = await pool.query(
      `SELECT id, nama, email, role, org, status
       FROM   public.dashboard_users
       WHERE  email    = $1
         AND  password = $2
         AND  status   = 'active'`,
      [email, password]  // ⚠ use bcrypt in production
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('POST /api/auth/login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard-users
// List all dashboard users
// ─────────────────────────────────────────────
app.get('/api/dashboard-users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nama, email, role, org, status, created_at
       FROM   public.dashboard_users
       ORDER  BY id`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('GET /api/dashboard-users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/dashboard-users
// Body: { nama, email, password, role, org, status }
// ─────────────────────────────────────────────
app.post('/api/dashboard-users', async (req, res) => {
  const { nama, email, password, role, org, status } = req.body;
  if (!nama || !email || !password) {
    return res.status(400).json({ error: 'nama, email, password are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO public.dashboard_users (nama, email, password, role, org, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nama, email, role, org, status`,
      [nama, email, password, role || 'viewer', org || null, status || 'active']
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('POST /api/dashboard-users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/dashboard-users/:id
// Body: { status } — toggle active/inactive
// ─────────────────────────────────────────────
app.patch('/api/dashboard-users/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['active','inactive'].includes(status)) {
    return res.status(400).json({ error: 'status must be "active" or "inactive"' });
  }

  try {
    const result = await pool.query(
      `UPDATE public.dashboard_users
       SET    status = $1, updated_at = NOW()
       WHERE  id = $2
       RETURNING id, nama, email, role, org, status`,
      [status, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/dashboard-users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/dashboard-users/:id
// ─────────────────────────────────────────────
app.delete('/api/dashboard-users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM public.dashboard_users WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/dashboard-users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│         UZHIYA Dashboard Backend            │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  Port    : ${PORT}                              │`);
  console.log(`│  DB Host : crossover.proxy.rlwy.net:17234   │`);
  console.log(`│  DB Name : railway                           │`);
  console.log(`│  Bot     : ${BOT.padEnd(32)}│`);
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  Dashboard : http://localhost:${PORT}               │`);
  console.log('├─────────────────────────────────────────────┤');
  console.log('│  GET  /health                               │');
  console.log('│  GET  /api/bot-limit                        │');
  console.log('│  POST /api/bot-limit      { limit }         │');
  console.log('│  POST /api/bot-status     { bot }           │');
  console.log('│  POST /api/refresh-cost                     │');
  console.log('│  GET  /api/token-tracker                    │');
  console.log('│  POST /api/auth/login                       │');
  console.log('│  GET  /api/dashboard-users                  │');
  console.log('│  POST /api/dashboard-users                  │');
  console.log('│  PATCH/DELETE /api/dashboard-users/:id      │');
  console.log('└─────────────────────────────────────────────┘');
  console.log('');
});