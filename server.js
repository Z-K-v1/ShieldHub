const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set!');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==================== DATABASE INIT ====================
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'USER',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scripts (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(100) NOT NULL DEFAULT 'Script',
                version VARCHAR(50) NOT NULL DEFAULT 'V1',
                real_content TEXT NOT NULL,
                public_content TEXT NOT NULL,
                token VARCHAR(64) UNIQUE NOT NULL,
                owner VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "sid" VARCHAR NOT NULL COLLATE "default",
                "sess" JSON NOT NULL,
                "expire" TIMESTAMP(6) NOT NULL,
                CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
            );
        `);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS slug VARCHAR(100) DEFAULT 'Script';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS version VARCHAR(50) DEFAULT 'V1';`);
        await pool.query(`UPDATE scripts SET slug = LOWER(REPLACE(name, ' ', '_')) WHERE slug = 'Script' OR slug IS NULL;`);
        await pool.query(`UPDATE scripts SET version = 'V1' WHERE version IS NULL;`);
        console.log('✅ Tables created/verified');

        const adminPass = process.env.ADMIN_PASSWORD;
        if (adminPass) {
            const existing = await pool.query('SELECT * FROM users WHERE username = $1', ['Z-K']);
            if (existing.rows.length === 0) {
                await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', ['Z-K', adminPass, 'ADMIN']);
                console.log('👑 Admin created');
            }
        }
    } catch (e) {
        console.error('❌ DB Init error:', e);
    }
}
initDB();

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'zyrox-kido-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

function requireLogin(req, res, next) {
    if (req.session.user) next();
    else res.redirect('/login');
}
function requireAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'ADMIN') next();
    else res.status(403).send('Access Denied');
}

const BRAND_NAME = 'By Zyrox-Kido';
const BRAND_SHORT = 'Zyrox-Kido';

// ==================== LOGO ====================
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#6366f1"/><stop offset="50%" style="stop-color:#8b5cf6"/><stop offset="100%" style="stop-color:#ec4899"/></linearGradient></defs><path d="M50 5 L85 20 L85 50 C85 75 70 90 50 95 C30 90 15 75 15 50 L15 20 Z" fill="url(#g)" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/><text x="50" y="62" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#fff" text-anchor="middle">ZK</text></svg>`;

app.get('/logo.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(LOGO_SVG);
});
app.get('/favicon.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(LOGO_SVG);
});
app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(LOGO_SVG);
});

// ==================== OBFUSCATION ====================
function obfuscateScript(code) {
    const encoded = Buffer.from(code, 'utf8').toString('base64');
    return `local _b64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local _d="${encoded}"
local _o={}
for _c in _d:gmatch(".") do
    local _n=_b64:find(_c,1,true)
    if _n then _o[#_o+1]=_n-1 end
end
local _r=""
for _i=1,#_o,4 do
    local _a=_o[_i] or 0
    local _b=_o[_i+1] or 0
    local _c=_o[_i+2] or 0
    local _d2=_o[_i+3] or 0
    local _n=_a*262144+_b*4096+_c*64+_d2
    _r=_r..string.char(math.floor(_n/65536)%256)
    if _c then _r=_r..string.char(math.floor(_n/256)%256) end
    if _d2 then _r=_r..string.char(_n%256) end
end
local _f=loadstring(_r)
if _f then _f() end`;
}

function makeSlug(name) {
    return name.toString().trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50) || 'Script';
}
function versionDropdown(selectedValue) {
    let options = '';
    for (let i = 1; i <= 1000; i++) {
        const v = 'V' + i;
        options += `<option value="${v}" ${v === selectedValue ? 'selected' : ''}>${v}</option>`;
    }
    return options;
}

function getHtmlHead(title) {
    return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} · ${BRAND_SHORT}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
    `;
}

// ==================== GLASSMORPHISM + GRADIENT STYLES ====================
const LAYOUT_STYLES = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    
    :root {
        --bg-base: #08080c;
        --bg-elevated: #101018;
        --bg-glass: rgba(20,20,32,0.5);
        --bg-glass-hover: rgba(30,30,48,0.6);
        --border-glass: rgba(255,255,255,0.08);
        --border-glass-hover: rgba(255,255,255,0.16);
        --text-primary: #ffffff;
        --text-secondary: #a1a1b8;
        --text-muted: #6b6b85;
        --accent-1: #6366f1;
        --accent-2: #8b5cf6;
        --accent-3: #ec4899;
        --accent-gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #ec4899 100%);
        --accent-gradient-soft: linear-gradient(135deg, rgba(99,102,241,0.15) 0%, rgba(139,92,246,0.15) 50%, rgba(236,72,153,0.15) 100%);
    }

    html, body { height: 100%; }
    body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        background: var(--bg-base);
        color: var(--text-primary);
        font-size: 14px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11', 'ss01';
        overflow-x: hidden;
        position: relative;
    }

    /* ====== Animated Gradient Blobs Background ====== */
    body::before,
    body::after {
        content: '';
        position: fixed;
        border-radius: 50%;
        filter: blur(120px);
        pointer-events: none;
        z-index: 0;
        opacity: 0.5;
    }
    body::before {
        top: -200px; left: -200px;
        width: 600px; height: 600px;
        background: radial-gradient(circle, #6366f1, transparent 70%);
        animation: blob1 20s ease-in-out infinite;
    }
    body::after {
        bottom: -200px; right: -200px;
        width: 600px; height: 600px;
        background: radial-gradient(circle, #ec4899, transparent 70%);
        animation: blob2 25s ease-in-out infinite;
    }
    @keyframes blob1 {
        0%, 100% { transform: translate(0, 0) scale(1); }
        33% { transform: translate(150px, 100px) scale(1.15); }
        66% { transform: translate(-50px, 200px) scale(0.9); }
    }
    @keyframes blob2 {
        0%, 100% { transform: translate(0, 0) scale(1); }
        50% { transform: translate(-150px, -100px) scale(1.2); }
    }

    /* Additional purple blob center */
    .blob-mid {
        position: fixed;
        top: 50%; left: 50%;
        width: 800px; height: 800px;
        transform: translate(-50%, -50%);
        background: radial-gradient(circle, rgba(139,92,246,0.15), transparent 60%);
        filter: blur(100px);
        pointer-events: none;
        z-index: 0;
        animation: pulseBlob 15s ease-in-out infinite;
    }
    @keyframes pulseBlob {
        0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.5; }
        50% { transform: translate(-50%, -50%) scale(1.3); opacity: 0.8; }
    }

    a { color: inherit; text-decoration: none; }
    button { font-family: inherit; cursor: pointer; border: none; background: none; color: inherit; }

    /* ===== Layout ===== */
    .layout { display: flex; min-height: 100vh; position: relative; z-index: 1; }

    /* ===== Sidebar (Glass) ===== */
    .sidebar {
        width: 264px;
        background: var(--bg-glass);
        backdrop-filter: blur(30px) saturate(180%);
        -webkit-backdrop-filter: blur(30px) saturate(180%);
        border-right: 1px solid var(--border-glass);
        padding: 20px 14px;
        display: flex;
        flex-direction: column;
        position: fixed;
        top: 0; left: 0; bottom: 0;
        z-index: 50;
        transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .sidebar-brand {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 10px 20px 10px;
        border-bottom: 1px solid var(--border-glass);
        margin-bottom: 16px;
    }
    .sidebar-logo {
        width: 40px; height: 40px;
        border-radius: 12px;
        background: var(--accent-gradient);
        display: flex; align-items: center; justify-content: center;
        font-weight: 900; font-size: 15px; color: #fff;
        box-shadow: 0 8px 32px rgba(139,92,246,0.4);
        flex-shrink: 0;
        position: relative;
        overflow: hidden;
    }
    .sidebar-logo::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%);
        pointer-events: none;
    }
    .sidebar-brand-text { display: flex; flex-direction: column; min-width: 0; }
    .sidebar-brand-name {
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700; font-size: 15px; color: var(--text-primary);
        letter-spacing: -0.3px;
    }
    .sidebar-brand-sub {
        font-size: 10px; color: var(--text-muted); font-weight: 600;
        letter-spacing: 0.8px; text-transform: uppercase;
        margin-top: 1px;
    }

    .sidebar-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }
    .nav-section-label {
        font-size: 10px; font-weight: 700; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 1.2px;
        padding: 14px 12px 6px 12px;
        user-select: none;
    }
    .nav-item {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 13.5px;
        font-weight: 600;
        color: var(--text-secondary);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        cursor: pointer;
        position: relative;
        user-select: none;
    }
    .nav-item:hover { 
        background: var(--bg-glass-hover); 
        color: var(--text-primary);
        transform: translateX(2px);
    }
    .nav-item.active {
        background: var(--accent-gradient-soft);
        color: var(--text-primary);
    }
    .nav-item.active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 20px;
        background: var(--accent-gradient);
        border-radius: 0 4px 4px 0;
        box-shadow: 0 0 12px rgba(139,92,246,0.6);
    }
    .nav-icon {
        width: 18px; height: 18px;
        display: flex; align-items: center; justify-content: center;
        font-size: 14px;
        flex-shrink: 0;
    }

    .sidebar-footer {
        padding-top: 14px;
        border-top: 1px solid var(--border-glass);
    }
    .user-card {
        display: flex; align-items: center; gap: 10px;
        padding: 10px;
        border-radius: 12px;
        background: var(--bg-glass);
        border: 1px solid var(--border-glass);
        transition: all 0.2s ease;
    }
    .user-card:hover { background: var(--bg-glass-hover); border-color: var(--border-glass-hover); }
    .user-avatar {
        width: 34px; height: 34px;
        border-radius: 10px;
        background: var(--accent-gradient);
        display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 13px; color: #fff;
        flex-shrink: 0;
        box-shadow: 0 4px 16px rgba(139,92,246,0.3);
    }
    .user-avatar-admin { background: linear-gradient(135deg, #f59e0b, #ef4444); box-shadow: 0 4px 16px rgba(245,158,11,0.4); }
    .user-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .user-name {
        font-size: 13px; font-weight: 700; color: var(--text-primary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .user-role {
        font-size: 10px; font-weight: 700; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: 0.6px;
    }

    /* ===== Main ===== */
    .main { flex: 1; margin-left: 264px; min-height: 100vh; display: flex; flex-direction: column; }

    /* ===== Topbar ===== */
    .topbar {
        height: 64px;
        background: var(--bg-glass);
        backdrop-filter: blur(30px) saturate(180%);
        -webkit-backdrop-filter: blur(30px) saturate(180%);
        border-bottom: 1px solid var(--border-glass);
        padding: 0 28px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        position: sticky;
        top: 0;
        z-index: 40;
    }
    .topbar-left { display: flex; align-items: center; gap: 16px; min-width: 0; flex: 1; }
    .topbar-title {
        font-size: 15px; font-weight: 700; color: var(--text-primary);
        letter-spacing: -0.3px;
        font-family: 'Space Grotesk', sans-serif;
    }
    .topbar-right { display: flex; align-items: center; gap: 8px; }

    .icon-btn {
        width: 38px; height: 38px;
        border-radius: 11px;
        background: var(--bg-glass);
        border: 1px solid var(--border-glass);
        display: flex; align-items: center; justify-content: center;
        color: var(--text-secondary);
        font-size: 15px;
        transition: all 0.2s ease;
    }
    .icon-btn:hover { 
        background: var(--bg-glass-hover); 
        color: var(--text-primary); 
        border-color: var(--border-glass-hover);
        transform: translateY(-1px);
    }

    /* ===== Content ===== */
    .content { padding: 32px; flex: 1; max-width: 1440px; width: 100%; margin: 0 auto; }

    /* ===== Page Header ===== */
    .page-header {
        display: flex; justify-content: space-between; align-items: flex-end;
        gap: 20px; flex-wrap: wrap;
        margin-bottom: 32px;
    }
    .page-title {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 32px; font-weight: 700; 
        background: var(--accent-gradient);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        letter-spacing: -1.2px;
        margin-bottom: 6px;
        line-height: 1.1;
    }
    .page-subtitle {
        font-size: 13.5px; color: var(--text-secondary); font-weight: 500;
    }

    /* ===== Buttons ===== */
    .btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        padding: 11px 20px;
        border-radius: 11px;
        font-weight: 700;
        font-size: 13px;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        cursor: pointer;
        white-space: nowrap;
        text-decoration: none;
        font-family: inherit;
        border: 1px solid transparent;
        letter-spacing: 0.1px;
        position: relative;
        overflow: hidden;
    }
    .btn:active { transform: scale(0.97); }

    .btn-primary {
        background: var(--accent-gradient);
        color: #fff;
        background-size: 200% 200%;
        animation: gradientShift 4s ease infinite;
        box-shadow: 0 4px 20px rgba(139,92,246,0.4), inset 0 1px 0 rgba(255,255,255,0.2);
    }
    @keyframes gradientShift {
        0%, 100% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
    }
    .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 32px rgba(139,92,246,0.5), inset 0 1px 0 rgba(255,255,255,0.3);
    }

    .btn-secondary {
        background: var(--bg-glass);
        backdrop-filter: blur(10px);
        color: var(--text-primary);
        border-color: var(--border-glass);
    }
    .btn-secondary:hover { 
        background: var(--bg-glass-hover); 
        border-color: var(--border-glass-hover); 
        transform: translateY(-2px);
    }

    .btn-danger {
        background: rgba(239,68,68,0.1);
        color: #f87171;
        border-color: rgba(239,68,68,0.2);
    }
    .btn-danger:hover { 
        background: rgba(239,68,68,0.15); 
        border-color: rgba(239,68,68,0.4);
        transform: translateY(-2px);
    }

    .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border-glass);
    }
    .btn-ghost:hover { 
        background: var(--bg-glass); 
        color: var(--text-primary); 
        border-color: var(--border-glass-hover); 
    }

    .btn-sm { padding: 8px 14px; font-size: 12px; border-radius: 9px; }

    /* ===== Stats ===== */
    .stats-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
        margin-bottom: 32px;
    }
    .stat {
        position: relative;
        background: var(--bg-glass);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid var(--border-glass);
        border-radius: 18px;
        padding: 22px 24px;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
    }
    .stat::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
    }
    .stat:hover {
        border-color: var(--border-glass-hover);
        transform: translateY(-4px);
        box-shadow: 0 24px 48px rgba(0,0,0,0.4), 0 0 40px rgba(139,92,246,0.15);
        background: var(--bg-glass-hover);
    }
    .stat-icon {
        width: 42px; height: 42px;
        border-radius: 12px;
        background: var(--accent-gradient);
        color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-size: 18px;
        margin-bottom: 16px;
        box-shadow: 0 8px 24px rgba(139,92,246,0.35);
        position: relative;
        overflow: hidden;
    }
    .stat-icon::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%);
        pointer-events: none;
    }
    .stat-label {
        font-size: 12px; font-weight: 600; color: var(--text-secondary);
        margin-bottom: 6px;
        letter-spacing: 0.3px;
    }
    .stat-value {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 32px; font-weight: 700; color: var(--text-primary);
        letter-spacing: -1.5px;
        line-height: 1.1;
    }

    /* ===== Scripts Grid ===== */
    .scripts-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 18px;
    }
    .script-card {
        position: relative;
        background: var(--bg-glass);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid var(--border-glass);
        border-radius: 18px;
        padding: 24px;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        flex-direction: column;
        gap: 16px;
        overflow: hidden;
    }
    .script-card::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
    }
    .script-card::after {
        content: '';
        position: absolute;
        inset: -1px;
        border-radius: 18px;
        padding: 1px;
        background: var(--accent-gradient);
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        opacity: 0;
        transition: opacity 0.35s ease;
        pointer-events: none;
    }
    .script-card:hover {
        background: var(--bg-glass-hover);
        transform: translateY(-4px);
        box-shadow: 0 28px 60px rgba(0,0,0,0.5), 0 0 60px rgba(139,92,246,0.2);
    }
    .script-card:hover::after { opacity: 0.6; }

    .script-card-header {
        display: flex; justify-content: space-between; align-items: flex-start;
        gap: 12px;
    }
    .script-card-icon {
        width: 46px; height: 46px;
        border-radius: 13px;
        background: var(--accent-gradient);
        display: flex; align-items: center; justify-content: center;
        font-size: 20px;
        flex-shrink: 0;
        box-shadow: 0 8px 24px rgba(139,92,246,0.35);
        position: relative;
        overflow: hidden;
    }
    .script-card-icon::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%);
    }
    .script-card-info { flex: 1; min-width: 0; padding-top: 2px; }
    .script-card-name {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 16px; font-weight: 700; color: var(--text-primary);
        letter-spacing: -0.3px;
        margin-bottom: 6px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .script-card-meta {
        font-size: 11.5px; color: var(--text-muted); font-weight: 500;
        display: flex; align-items: center; gap: 8px;
        flex-wrap: wrap;
    }
    .badge {
        display: inline-flex; align-items: center;
        padding: 3px 10px;
        border-radius: 8px;
        font-size: 10px; font-weight: 800;
        letter-spacing: 0.5px;
        border: 1px solid transparent;
        backdrop-filter: blur(10px);
    }
    .badge-version {
        background: rgba(139,92,246,0.15);
        color: #c4b5fd;
        border-color: rgba(139,92,246,0.3);
    }
    .badge-admin {
        background: rgba(245,158,11,0.15);
        color: #fbbf24;
        border-color: rgba(245,158,11,0.3);
    }
    .badge-user {
        background: rgba(99,102,241,0.15);
        color: #a5b4fc;
        border-color: rgba(99,102,241,0.3);
    }

    .script-card-url {
        background: rgba(0,0,0,0.3);
        border: 1px solid var(--border-glass);
        border-radius: 11px;
        padding: 12px 14px;
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 10.5px;
        color: #c4b5fd;
        word-break: break-all;
        line-height: 1.6;
        transition: border-color 0.2s ease;
    }
    .script-card-url:hover { border-color: var(--border-glass-hover); }

    .script-card-actions {
        display: flex; gap: 8px; flex-wrap: wrap;
        padding-top: 6px;
    }
    .script-card-actions .btn { flex: 1; min-width: calc(50% - 5px); justify-content: center; }

    /* ===== Empty ===== */
    .empty {
        background: var(--bg-glass);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px dashed var(--border-glass-hover);
        border-radius: 18px;
        padding: 80px 30px;
        text-align: center;
    }
    .empty-icon {
        width: 80px; height: 80px;
        border-radius: 22px;
        background: var(--accent-gradient-soft);
        border: 1px solid var(--border-glass);
        display: flex; align-items: center; justify-content: center;
        font-size: 36px;
        margin: 0 auto 22px;
    }
    .empty-title { 
        font-family: 'Space Grotesk', sans-serif;
        font-size: 18px; font-weight: 700; color: var(--text-primary); 
        margin-bottom: 8px; 
        letter-spacing: -0.3px; 
    }
    .empty-desc { font-size: 13.5px; color: var(--text-secondary); margin-bottom: 24px; }

    /* ===== Card / Form ===== */
    .card {
        position: relative;
        background: var(--bg-glass);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid var(--border-glass);
        border-radius: 18px;
        padding: 32px;
        overflow: hidden;
    }
    .card::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
    }
    .form-group { margin-bottom: 22px; }
    .form-label {
        display: block;
        font-size: 12px; font-weight: 700; color: var(--text-secondary);
        margin-bottom: 10px;
        letter-spacing: 0.4px;
        text-transform: uppercase;
    }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 22px; }
    input, textarea, select {
        width: 100%;
        padding: 13px 16px;
        background: rgba(0,0,0,0.3);
        border: 1px solid var(--border-glass);
        border-radius: 11px;
        color: var(--text-primary);
        font-size: 14px;
        font-family: inherit;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        outline: none;
        backdrop-filter: blur(10px);
    }
    input:focus, textarea:focus, select:focus {
        border-color: rgba(139,92,246,0.6);
        background: rgba(0,0,0,0.4);
        box-shadow: 0 0 0 4px rgba(139,92,246,0.15), 0 0 30px rgba(139,92,246,0.15);
    }
    input::placeholder, textarea::placeholder { color: var(--text-muted); }
    textarea {
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 12.5px;
        line-height: 1.7;
        resize: vertical;
        min-height: 340px;
    }
    select {
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1b8' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'/%3e%3c/svg%3e");
        background-repeat: no-repeat;
        background-position: right 14px center;
        background-size: 16px;
        padding-right: 44px;
    }

    /* ===== User List ===== */
    .user-row {
        position: relative;
        background: var(--bg-glass);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid var(--border-glass);
        border-radius: 16px;
        padding: 18px 22px;
        display: flex; align-items: center; gap: 16px;
        margin-bottom: 12px;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
    }
    .user-row:hover {
        border-color: var(--border-glass-hover);
        background: var(--bg-glass-hover);
        transform: translateX(4px);
        box-shadow: 0 16px 40px rgba(0,0,0,0.35), 0 0 30px rgba(139,92,246,0.1);
    }
    .user-row .user-avatar { width: 46px; height: 46px; border-radius: 13px; font-size: 17px; }
    .user-row-info { flex: 1; min-width: 0; }
    .user-row-name {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 15px; font-weight: 700; color: var(--text-primary);
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 4px;
    }
    .user-row-meta { font-size: 12px; color: var(--text-muted); font-weight: 500; }

    /* ===== Toast ===== */
    @keyframes toastIn {
        from { transform: translateX(400px) scale(0.9); opacity: 0; }
        to { transform: translateX(0) scale(1); opacity: 1; }
    }
    @keyframes toastOut {
        to { transform: translateX(400px) scale(0.9); opacity: 0; }
    }
    .toast {
        position: fixed; bottom: 28px; right: 28px;
        background: var(--bg-glass);
        backdrop-filter: blur(30px) saturate(180%);
        -webkit-backdrop-filter: blur(30px) saturate(180%);
        border: 1px solid var(--border-glass-hover);
        color: var(--text-primary);
        padding: 15px 22px;
        border-radius: 14px;
        font-weight: 600;
        font-size: 13.5px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.6), 0 0 40px rgba(139,92,246,0.2);
        z-index: 9999;
        display: flex; align-items: center; gap: 12px;
        animation: toastIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        max-width: 90vw;
    }
    .toast.hiding { animation: toastOut 0.3s ease forwards; }
    .toast::before {
        content: '';
        width: 10px; height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
    }
    .toast.success::before { 
        background: #22c55e; 
        box-shadow: 0 0 16px #22c55e; 
    }
    .toast.error::before { 
        background: #ef4444; 
        box-shadow: 0 0 16px #ef4444; 
    }

    /* ===== Login ===== */
    .login-wrap {
        min-height: 100vh;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        position: relative;
        z-index: 1;
    }
    .login-card {
        position: relative;
        background: var(--bg-glass);
        backdrop-filter: blur(40px) saturate(180%);
        -webkit-backdrop-filter: blur(40px) saturate(180%);
        border: 1px solid var(--border-glass-hover);
        border-radius: 26px;
        padding: 48px 44px;
        width: 440px;
        max-width: 100%;
        box-shadow: 0 50px 120px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .login-card::before {
        content: '';
        position: absolute;
        top: 0; left: 50%;
        transform: translateX(-50%);
        width: 70%; height: 1px;
        background: var(--accent-gradient);
        opacity: 0.8;
    }
    .login-brand {
        display: flex; flex-direction: column; align-items: center;
        margin-bottom: 36px;
        text-align: center;
    }
    .login-logo {
        width: 76px; height: 76px;
        border-radius: 22px;
        background: var(--accent-gradient);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700; font-size: 28px; color: #fff;
        margin-bottom: 20px;
        box-shadow: 0 16px 48px rgba(139,92,246,0.5), inset 0 2px 0 rgba(255,255,255,0.2);
        position: relative;
        overflow: hidden;
    }
    .login-logo::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%);
        pointer-events: none;
    }
    .login-title { 
        font-family: 'Space Grotesk', sans-serif;
        font-size: 26px; font-weight: 700; 
        background: var(--accent-gradient);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        letter-spacing: -0.8px; 
        margin-bottom: 8px; 
    }
    .login-sub { font-size: 13.5px; color: var(--text-secondary); font-weight: 500; }
    .login-card input { margin-bottom: 14px; padding: 14px 16px; }
    .login-card .btn-primary { width: 100%; padding: 14px; font-size: 14.5px; margin-top: 8px; }
    .login-msg { margin-top: 16px; text-align: center; font-size: 12.5px; font-weight: 600; min-height: 18px; }
    .login-msg.error { color: #f87171; }
    .login-msg.success { color: #4ade80; }
    .login-link { 
        display: block; 
        text-align: center; 
        margin-top: 24px; 
        font-size: 13px; 
        background: var(--accent-gradient);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        font-weight: 700;
        transition: opacity 0.2s;
    }
    .login-link:hover { opacity: 0.8; }

    /* ===== Mobile ===== */
    .menu-btn {
        display: none;
        width: 40px; height: 40px;
        border-radius: 11px;
        background: var(--bg-glass);
        border: 1px solid var(--border-glass);
        align-items: center; justify-content: center;
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
        transition: all 0.2s ease;
    }
    .menu-btn:hover { background: var(--bg-glass-hover); color: var(--text-primary); }

    .overlay {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.7);
        backdrop-filter: blur(4px);
        z-index: 45;
        animation: fadeIn 0.25s ease;
    }
    .overlay.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    /* ===== Scrollbar ===== */
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { 
        background: var(--border-glass-hover); 
        border-radius: 5px; 
        border: 2px solid var(--bg-base); 
    }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }

    /* ===== Responsive ===== */
    @media (max-width: 900px) {
        .sidebar { transform: translateX(-100%); }
        .sidebar.open { transform: translateX(0); box-shadow: 40px 0 100px rgba(0,0,0,0.8); }
        .main { margin-left: 0; }
        .menu-btn { display: flex; }
        .content { padding: 22px; }
        .topbar { padding: 0 22px; }
        .page-title { font-size: 26px; }
        .scripts-grid { grid-template-columns: 1fr; }
        .form-row { grid-template-columns: 1fr; }
        .card { padding: 24px; }
        .stats-row { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 480px) {
        .content { padding: 16px; }
        .topbar { padding: 0 16px; height: 60px; }
        .page-title { font-size: 22px; }
        .page-header { margin-bottom: 22px; }
        .card { padding: 20px; border-radius: 16px; }
        .stat { padding: 18px 20px; border-radius: 16px; }
        .stat-value { font-size: 26px; }
        .script-card { padding: 20px; border-radius: 16px; }
        .login-card { padding: 36px 26px; border-radius: 22px; }
        .login-logo { width: 64px; height: 64px; font-size: 24px; border-radius: 18px; }
        .login-title { font-size: 22px; }
        .stats-row { grid-template-columns: 1fr 1fr; gap: 12px; }
    }
`;

// ==================== TOAST SCRIPT ====================
const TOAST_SCRIPT = `
    function showToast(message, type = 'success') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const t = document.createElement('div');
        t.className = 'toast ' + type;
        t.textContent = message;
        document.body.appendChild(t);
        setTimeout(() => { t.classList.add('hiding'); setTimeout(() => t.remove(), 300); }, 2400);
    }
    function copyText(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
            if (btn) { const o = btn.innerHTML; btn.innerHTML = '✓ Copied'; setTimeout(() => btn.innerHTML = o, 1400); }
            showToast('Copied to clipboard', 'success');
        }).catch(() => showToast('Failed to copy', 'error'));
    }
    function confirmDelete(token, name) {
        if (confirm('Delete "' + name + '"?')) window.location.href = '/delete/' + token;
    }
    function toggleSidebar() {
        document.querySelector('.sidebar').classList.toggle('open');
        document.querySelector('.overlay').classList.toggle('active');
    }
`;

// ==================== LAYOUT ====================
function renderLayout({ title, pageTitle, pageSubtitle, content, user, activeNav, actions }) {
    const isAdmin = user.role === 'ADMIN';
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>${getHtmlHead(title)}<style>${LAYOUT_STYLES}</style></head>
    <body>
        <div class="blob-mid"></div>
        <div class="layout">
            <aside class="sidebar" id="sidebar">
                <div class="sidebar-brand">
                    <div class="sidebar-logo">ZK</div>
                    <div class="sidebar-brand-text">
                        <div class="sidebar-brand-name">${BRAND_SHORT}</div>
                        <div class="sidebar-brand-sub">By Zyrox-Kido</div>
                    </div>
                </div>
                <nav class="sidebar-nav">
                    <div class="nav-section-label">Workspace</div>
                    <a href="/" class="nav-item ${activeNav === 'dashboard' ? 'active' : ''}">
                        <span class="nav-icon">◈</span> Dashboard
                    </a>
                    <a href="/create" class="nav-item ${activeNav === 'create' ? 'active' : ''}">
                        <span class="nav-icon">✦</span> Create Script
                    </a>
                    ${isAdmin ? `
                    <div class="nav-section-label">Administration</div>
                    <a href="/admin" class="nav-item ${activeNav === 'admin' ? 'active' : ''}">
                        <span class="nav-icon">♛</span> Admin Panel
                    </a>
                    ` : ''}
                </nav>
                <div class="sidebar-footer">
                    <a href="/logout" class="user-card">
                        <div class="user-avatar ${isAdmin ? 'user-avatar-admin' : ''}">${user.username.charAt(0).toUpperCase()}</div>
                        <div class="user-meta">
                            <div class="user-name">${user.username}</div>
                            <div class="user-role">${isAdmin ? '♛ Admin' : 'Member'}</div>
                        </div>
                    </a>
                </div>
            </aside>
            <div class="overlay" onclick="toggleSidebar()"></div>
            <div class="main">
                <header class="topbar">
                    <div class="topbar-left">
                        <button class="menu-btn" onclick="toggleSidebar()">☰</button>
                        <div class="topbar-title">${pageTitle}</div>
                    </div>
                    <div class="topbar-right">
                        <a href="/logout" class="icon-btn" title="Logout">⏻</a>
                    </div>
                </header>
                <div class="content">
                    <div class="page-header">
                        <div>
                            <div class="page-title">${pageTitle}</div>
                            ${pageSubtitle ? `<div class="page-subtitle">${pageSubtitle}</div>` : ''}
                        </div>
                        ${actions || ''}
                    </div>
                    ${content}
                </div>
            </div>
        </div>
        <script>${TOAST_SCRIPT}</script>
    </body>
    </html>
    `;
}

function renderScriptCard(s) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const slug = s.slug || 'Script';
    const version = s.version || 'V1';
    const prettyUrl = `${baseUrl}/raw/${slug}/${version}/${s.token}`;
    return `
    <div class="script-card">
        <div class="script-card-header">
            <div class="script-card-icon">◈</div>
            <div class="script-card-info">
                <div class="script-card-name">${s.name}</div>
                <div class="script-card-meta">
                    <span class="badge badge-version">${version}</span>
                    <span>${new Date(s.created_at).toLocaleDateString()}</span>
                </div>
            </div>
        </div>
        <div class="script-card-url">${prettyUrl}</div>
        <div class="script-card-actions">
            <button class="btn btn-primary btn-sm" onclick="copyText('loadstring(game:HttpGet(\\'${prettyUrl}\\'))()', this)">📋 Copy</button>
            <a href="/view/${slug}/${version}/${s.token}" target="_blank" class="btn btn-secondary btn-sm">◉ View</a>
            <a href="/edit/${s.token}" class="btn btn-ghost btn-sm">✎ Edit</a>
            <button class="btn btn-danger btn-sm" onclick="confirmDelete('${s.token}', '${s.name}')">🗑 Delete</button>
        </div>
    </div>
    `;
}

// ==================== LOGIN ====================
app.get('/login', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>${getHtmlHead('Login')}<style>${LAYOUT_STYLES}</style></head>
    <body>
        <div class="blob-mid"></div>
        <div class="login-wrap">
            <div class="login-card">
                <div class="login-brand">
                    <div class="login-logo">ZK</div>
                    <div class="login-title">Welcome back</div>
                    <div class="login-sub">Sign in to continue to ${BRAND_SHORT}</div>
                </div>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required autofocus>
                    <input type="password" name="password" placeholder="Password" required>
                    <button type="submit" class="btn btn-primary">Sign In →</button>
                </form>
                <div class="login-msg error">${req.query.error ? 'Invalid credentials' : ''}</div>
                <div class="login-msg success">${req.query.registered ? 'Account created! Please sign in.' : ''}</div>
                <a href="/register" class="login-link">Create an account →</a>
            </div>
        </div>
    </body>
    </html>
    `);
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (result.rows.length === 0) return res.redirect('/login?error=1');
        const user = result.rows[0];
        if (user.password !== password) return res.redirect('/login?error=1');
        req.session.user = { username: user.username, role: user.role };
        res.redirect('/');
    } catch (e) { res.redirect('/login?error=1'); }
});

// ==================== REGISTER ====================
app.get('/register', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>${getHtmlHead('Register')}<style>${LAYOUT_STYLES}</style></head>
    <body>
        <div class="blob-mid"></div>
        <div class="login-wrap">
            <div class="login-card">
                <div class="login-brand">
                    <div class="login-logo">ZK</div>
                    <div class="login-title">Create account</div>
                    <div class="login-sub">Join ${BRAND_SHORT} today</div>
                </div>
                <form action="/register" method="POST">
                    <input type="text" name="username" placeholder="Username" required autofocus>
                    <input type="password" name="password" placeholder="Password" required>
                    <input type="password" name="confirmPassword" placeholder="Confirm password" required>
                    <button type="submit" class="btn btn-primary">Create Account →</button>
                </form>
                <div class="login-msg error">${req.query.error || ''}</div>
                <a href="/login" class="login-link">← Back to sign in</a>
            </div>
        </div>
    </body>
    </html>
    `);
});

app.post('/register', async (req, res) => {
    try {
        const { username, password, confirmPassword } = req.body;
        if (password !== confirmPassword) return res.redirect('/register?error=Passwords do not match');
        if (username.length < 2 || password.length < 4) return res.redirect('/register?error=Min 2 chars name, 4 chars password');
        const existing = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existing.rows.length > 0) return res.redirect('/register?error=Username taken');
        const role = username === 'Z-K' ? 'ADMIN' : 'USER';
        await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, password, role]);
        res.redirect('/login?registered=1');
    } catch (e) { res.redirect('/register?error=Server error'); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==================== DASHBOARD ====================
app.get('/', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [req.session.user.username]);
        const myScripts = result.rows;
        const isAdmin = req.session.user.role === 'ADMIN';

        const statsHtml = `
            <div class="stats-row">
                <div class="stat">
                    <div class="stat-icon">◈</div>
                    <div class="stat-label">Total Scripts</div>
                    <div class="stat-value">${myScripts.length}</div>
                </div>
                <div class="stat">
                    <div class="stat-icon">${isAdmin ? '♛' : '★'}</div>
                    <div class="stat-label">Account Role</div>
                    <div class="stat-value" style="font-size:24px;">${isAdmin ? 'Admin' : 'Member'}</div>
                </div>
                <div class="stat">
                    <div class="stat-icon">◉</div>
                    <div class="stat-label">Username</div>
                    <div class="stat-value" style="font-size:24px;">${req.session.user.username}</div>
                </div>
            </div>
        `;

        const scriptsHtml = myScripts.length === 0
            ? `<div class="empty">
                <div class="empty-icon">◈</div>
                <div class="empty-title">No scripts yet</div>
                <div class="empty-desc">Create your first script to get started</div>
                <a href="/create" class="btn btn-primary">✦ Create Script</a>
               </div>`
            : `<div class="scripts-grid">${myScripts.map(renderScriptCard).join('')}</div>`;

        res.send(renderLayout({
            title: 'Dashboard',
            pageTitle: 'Dashboard',
            pageSubtitle: 'Manage and organize your Lua scripts',
            content: statsHtml + scriptsHtml,
            user: req.session.user,
            activeNav: 'dashboard',
            actions: `<a href="/create" class="btn btn-primary">✦ New Script</a>`
        }));
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== CREATE ====================
app.get('/create', requireLogin, (req, res) => {
    const content = `
        <div class="card" style="max-width:920px">
            <form action="/create" method="POST">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Script Name</label>
                        <input type="text" name="name" placeholder="e.g., God Mode" required autofocus>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Version</label>
                        <select name="version" required>${versionDropdown('V1')}</select>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Lua Code</label>
                    <textarea name="content" placeholder="-- Paste your Lua script here..." required></textarea>
                </div>
                <div style="display:flex;gap:12px;flex-wrap:wrap;">
                    <button type="submit" class="btn btn-primary">💾 Save Script</button>
                    <a href="/" class="btn btn-ghost">Cancel</a>
                </div>
            </form>
        </div>
    `;
    res.send(renderLayout({
        title: 'Create Script',
        pageTitle: 'Create Script',
        pageSubtitle: 'Add a new Lua script to your collection',
        content,
        user: req.session.user,
        activeNav: 'create'
    }));
});

app.post('/create', requireLogin, async (req, res) => {
    try {
        const { name, version, content } = req.body;
        const slug = makeSlug(name);
        const ver = version || 'V1';
        const token = crypto.randomBytes(16).toString('hex');
        await pool.query(
            'INSERT INTO scripts (name, slug, version, real_content, public_content, token, owner) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [name, slug, ver, content, obfuscateScript(content), token, req.session.user.username]
        );
        res.redirect('/');
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ==================== EDIT ====================
app.get('/edit/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");
        const escaped = script.real_content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const content = `
            <div class="card" style="max-width:920px">
                <form action="/edit/${script.token}" method="POST">
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Script Name</label>
                            <input type="text" name="name" value="${script.name}" required>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Version</label>
                            <select name="version" required>${versionDropdown(script.version)}</select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Lua Code</label>
                        <textarea name="content" required>${escaped}</textarea>
                    </div>
                    <div style="display:flex;gap:12px;flex-wrap:wrap;">
                        <button type="submit" class="btn btn-primary">💾 Save Changes</button>
                        <a href="/" class="btn btn-ghost">Cancel</a>
                    </div>
                </form>
            </div>
        `;
        res.send(renderLayout({
            title: 'Edit Script',
            pageTitle: `Edit: ${script.name}`,
            pageSubtitle: 'Update your script',
            content,
            user: req.session.user,
            activeNav: 'dashboard'
        }));
    } catch (e) { res.status(500).send('Error'); }
});

app.post('/edit/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");
        const slug = makeSlug(req.body.name);
        const ver = req.body.version || 'V1';
        await pool.query(
            'UPDATE scripts SET name = $1, slug = $2, version = $3, real_content = $4, public_content = $5 WHERE token = $6',
            [req.body.name, slug, ver, req.body.content, obfuscateScript(req.body.content), req.params.token]
        );
        res.redirect('/');
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== VIEW ====================
app.get('/view/:slug/:version/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        const script = result.rows[0];
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const prettyUrl = `${baseUrl}/raw/${script.slug}/${script.version}/${script.token}`;
        const loadstring = `loadstring(game:HttpGet("${prettyUrl}"))()`;
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>${getHtmlHead(script.name)}<style>${LAYOUT_STYLES}</style></head>
        <body>
            <div class="blob-mid"></div>
            <div class="login-wrap">
                <div class="login-card" style="width:640px;text-align:center;">
                    <div class="login-brand" style="margin-bottom:24px;">
                        <div class="login-logo">ZK</div>
                        <div class="login-title">${script.name}</div>
                        <div class="login-sub" style="display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;margin-top:10px;">
                            <span class="badge badge-version">${script.version}</span>
                            <span style="color:var(--text-muted);font-size:12px;font-weight:600;">Protected Script</span>
                        </div>
                    </div>
                    <div style="background:rgba(0,0,0,0.3);border:1px solid var(--border-glass);border-radius:14px;padding:20px;margin-bottom:18px;text-align:left;">
                        <div style="font-size:10px;font-weight:800;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:12px;">Loadstring</div>
                        <div id="lsBox" style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#c4b5fd;word-break:break-all;line-height:1.8;">${loadstring}</div>
                    </div>
                    <button class="btn btn-primary" style="width:100%;padding:15px;font-size:14.5px;" onclick="copyText(document.getElementById('lsBox').innerText, this)">📋 Copy Loadstring</button>
                    <div style="margin-top:24px;font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.6px;">Protected by ${BRAND_NAME}</div>
                </div>
            </div>
            <script>${TOAST_SCRIPT}</script>
        </body>
        </html>
        `);
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== RAW ====================
app.get('/raw/:slug/:version/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(403).send("-- Denied --");
        const script = result.rows[0];
        if (script.slug !== req.params.slug || script.version !== req.params.version) return res.status(403).send("-- Denied --");
        const ua = req.headers['user-agent'] || '';
        const blocked = ['Mozilla', 'Chrome', 'Safari', 'Firefox', 'Edge', 'curl', 'wget', 'Postman'];
        for (const b of blocked) if (ua.includes(b)) return res.status(403).send("-- Protected --");
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(script.public_content);
    } catch (e) { res.status(500).send("-- Server Error --"); }
});

// ==================== ADMIN ====================
app.get('/admin', requireLogin, requireAdmin, async (req, res) => {
    try {
        const usersResult = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
        const users = usersResult.rows;
        const scriptsCountResult = await pool.query('SELECT owner, COUNT(*) as count FROM scripts GROUP BY owner');
        const scriptsCount = {};
        scriptsCountResult.rows.forEach(r => { scriptsCount[r.owner] = r.count; });

        let rows = '';
        users.forEach(u => {
            const count = scriptsCount[u.username] || 0;
            const isUserAdmin = u.role === 'ADMIN';
            rows += `
                <a href="/admin/user/${encodeURIComponent(u.username)}" class="user-row">
                    <div class="user-avatar ${isUserAdmin ? 'user-avatar-admin' : ''}">${u.username.charAt(0)}</div>
                    <div class="user-row-info">
                        <div class="user-row-name">
                            ${u.username}
                            <span class="badge ${isUserAdmin ? 'badge-admin' : 'badge-user'}">${u.role}</span>
                        </div>
                        <div class="user-row-meta">Joined ${new Date(u.created_at).toLocaleDateString()} · ${count} script${count !== 1 ? 's' : ''}</div>
                    </div>
                    <span class="btn btn-ghost btn-sm">View →</span>
                </a>
            `;
        });

        const content = rows || `<div class="empty"><div class="empty-icon">◉</div><div class="empty-title">No users yet</div></div>`;

        res.send(renderLayout({
            title: 'Admin',
            pageTitle: 'Admin Panel',
            pageSubtitle: `${users.length} user${users.length !== 1 ? 's' : ''} total`,
            content,
            user: req.session.user,
            activeNav: 'admin'
        }));
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/admin/user/:username', requireLogin, requireAdmin, async (req, res) => {
    try {
        const targetUser = req.params.username;
        const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [targetUser]);
        if (userResult.rows.length === 0) return res.status(404).send('Not found');
        const targetUserData = userResult.rows[0];
        const scriptsResult = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [targetUser]);
        const userScripts = scriptsResult.rows;

        const infoCard = `
            <div class="card" style="margin-bottom:22px;">
                <div style="display:flex;align-items:center;gap:16px;">
                    <div class="user-avatar ${targetUserData.role === 'ADMIN' ? 'user-avatar-admin' : ''}" style="width:56px;height:56px;border-radius:16px;font-size:22px;">${targetUser.charAt(0)}</div>
                    <div>
                        <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:10px;">
                            ${targetUser}
                            <span class="badge ${targetUserData.role === 'ADMIN' ? 'badge-admin' : 'badge-user'}">${targetUserData.role}</span>
                        </div>
                        <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">Joined ${new Date(targetUserData.created_at).toLocaleDateString()}</div>
                    </div>
                </div>
            </div>
        `;

        const scriptsHtml = userScripts.length === 0
            ? `<div class="empty"><div class="empty-icon">◈</div><div class="empty-title">No scripts</div><div class="empty-desc">This user hasn't created any scripts yet.</div></div>`
            : `<div class="scripts-grid">${userScripts.map(renderScriptCard).join('')}</div>`;

        res.send(renderLayout({
            title: `${targetUser}'s Scripts`,
            pageTitle: `${targetUser}'s Scripts`,
            pageSubtitle: `${userScripts.length} script${userScripts.length !== 1 ? 's' : ''}`,
            content: infoCard + scriptsHtml,
            user: req.session.user,
            activeNav: 'admin',
            actions: `<a href="/admin" class="btn btn-ghost">← All Users</a>`
        }));
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== DELETE ====================
app.get('/delete/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.redirect('/');
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");
        await pool.query('DELETE FROM scripts WHERE token = $1', [req.params.token]);
        if (isAdmin && script.owner !== req.session.user.username) return res.redirect('/admin/user/' + encodeURIComponent(script.owner));
        res.redirect('/');
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`✅ ${BRAND_NAME} v26.0 — Glassmorphism Edition`);
    console.log(`🎨 Gradient + Glass UI`);
});
