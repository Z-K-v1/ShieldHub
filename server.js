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
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#ff3b3b"/><stop offset="100%" style="stop-color:#cc0000"/></linearGradient></defs><path d="M50 5 L85 20 L85 50 C85 75 70 90 50 95 C30 90 15 75 15 50 L15 20 Z" fill="url(#g)" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/><text x="50" y="62" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#fff" text-anchor="middle">ZK</text></svg>`;

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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0a0505">
    <title>${title} · ${BRAND_SHORT}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="apple-touch-icon" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
    `;
}

// ==================== RED PREMIUM STYLES (PC + CP Optimized) ====================
const LAYOUT_STYLES = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    :root {
        --bg-0: #0a0505;
        --bg-1: #0f0808;
        --bg-2: #150a0a;
        --bg-3: #1c0d0d;
        --border-0: #2a1414;
        --border-1: #3a1a1a;
        --border-2: #4d2020;
        --text-0: #ffffff;
        --text-1: #d4d4d4;
        --text-2: #8a8a8a;
        --text-3: #5a5a5a;
        --accent: #ff3b3b;
        --accent-bright: #ff5555;
        --accent-dim: rgba(255,59,59,0.1);
        --accent-glow: rgba(255,59,59,0.5);
        --red-1: #ff3b3b;
        --red-2: #cc0000;
        --orange: #ff8c42;
        --purple: #b855ff;
        --blue: #4a9eff;
    }
    html, body { height: 100%; }
    html { -webkit-text-size-adjust: 100%; }
    body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg-0);
        color: var(--text-0);
        font-size: 14px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11';
        overflow-x: hidden;
        position: relative;
        min-height: 100vh;
        overscroll-behavior-y: none;
    }

    /* Ambient red glows */
    body::before {
        content: '';
        position: fixed;
        inset: 0;
        background:
            radial-gradient(ellipse 900px 700px at 15% -10%, rgba(255,59,59,0.15) 0%, transparent 55%),
            radial-gradient(ellipse 900px 700px at 85% 110%, rgba(184,85,255,0.08) 0%, transparent 55%);
        pointer-events: none;
        z-index: 0;
    }

    a { color: inherit; text-decoration: none; }
    button { font-family: inherit; cursor: pointer; border: none; background: none; color: inherit; }
    input, textarea, select, button { -webkit-appearance: none; appearance: none; }

    /* ===== Layout ===== */
    .layout { display: flex; min-height: 100vh; position: relative; z-index: 1; }

    /* ===== Sidebar ===== */
    .sidebar {
        width: 264px;
        background: rgba(15,8,8,0.7);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border-right: 1px solid var(--border-0);
        padding: 20px 14px;
        display: flex;
        flex-direction: column;
        position: fixed;
        top: 0; left: 0; bottom: 0;
        z-index: 50;
        transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        padding-top: max(20px, env(safe-area-inset-top));
        padding-bottom: max(20px, env(safe-area-inset-bottom));
        padding-left: max(14px, env(safe-area-inset-left));
    }
    .sidebar-brand {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 6px 10px 18px 10px;
        border-bottom: 1px solid var(--border-0);
        margin-bottom: 16px;
    }
    .sidebar-logo {
        width: 40px; height: 40px;
        border-radius: 12px;
        background: linear-gradient(135deg, var(--red-1), var(--red-2));
        display: flex; align-items: center; justify-content: center;
        font-weight: 900; font-size: 16px; color: #fff;
        box-shadow: 0 4px 24px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.3);
        flex-shrink: 0;
    }
    .sidebar-brand-text { display: flex; flex-direction: column; min-width: 0; }
    .sidebar-brand-name {
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700; font-size: 15px; color: var(--text-0);
        letter-spacing: -0.3px;
    }
    .sidebar-brand-sub {
        font-size: 10px; color: var(--text-3); font-weight: 700;
        letter-spacing: 0.8px; text-transform: uppercase;
        margin-top: 2px;
    }

    .sidebar-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }
    .nav-section-label {
        font-size: 10px; font-weight: 700; color: var(--text-3);
        text-transform: uppercase; letter-spacing: 1.2px;
        padding: 14px 12px 6px 12px;
        user-select: none;
    }
    .nav-item {
        display: flex; align-items: center; gap: 12px;
        padding: 11px 12px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-1);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        cursor: pointer;
        position: relative;
        user-select: none;
        min-height: 44px;
    }
    .nav-item:hover { background: var(--bg-2); color: var(--text-0); }
    .nav-item.active {
        background: var(--accent-dim);
        color: var(--accent);
    }
    .nav-item.active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 22px;
        background: linear-gradient(180deg, var(--red-1), var(--red-2));
        border-radius: 0 4px 4px 0;
        box-shadow: 0 0 12px var(--accent-glow);
    }
    .nav-icon {
        width: 20px; height: 20px;
        display: flex; align-items: center; justify-content: center;
        font-size: 15px;
        flex-shrink: 0;
    }

    .sidebar-footer {
        padding-top: 14px;
        border-top: 1px solid var(--border-0);
    }
    .user-card {
        display: flex; align-items: center; gap: 10px;
        padding: 10px;
        border-radius: 11px;
        background: var(--bg-2);
        border: 1px solid transparent;
        transition: all 0.2s ease;
        min-height: 52px;
    }
    .user-card:hover { background: var(--bg-3); border-color: var(--border-1); }
    .user-avatar {
        width: 34px; height: 34px;
        border-radius: 10px;
        background: linear-gradient(135deg, var(--red-1), var(--red-2));
        display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 14px; color: #fff;
        flex-shrink: 0;
        box-shadow: 0 2px 12px var(--accent-glow);
    }
    .user-avatar-admin { background: linear-gradient(135deg, #ffaa00, #ff6600); box-shadow: 0 2px 12px rgba(255,170,0,0.5); }
    .user-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .user-name {
        font-size: 13.5px; font-weight: 700; color: var(--text-0);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .user-role {
        font-size: 10px; font-weight: 800; color: var(--text-3);
        text-transform: uppercase; letter-spacing: 0.6px;
    }

    /* ===== Main ===== */
    .main { flex: 1; margin-left: 264px; min-height: 100vh; display: flex; flex-direction: column; width: 100%; }

    /* ===== Topbar ===== */
    .topbar {
        height: 64px;
        background: rgba(10,5,5,0.85);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border-bottom: 1px solid var(--border-0);
        padding: 0 28px;
        padding-top: env(safe-area-inset-top);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        position: sticky;
        top: 0;
        z-index: 40;
    }
    .topbar-left { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
    .topbar-title {
        font-size: 15px; font-weight: 700; color: var(--text-0);
        letter-spacing: -0.3px;
        font-family: 'Space Grotesk', sans-serif;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .topbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

    .icon-btn {
        width: 40px; height: 40px;
        border-radius: 11px;
        background: var(--bg-2);
        border: 1px solid var(--border-0);
        display: flex; align-items: center; justify-content: center;
        color: var(--text-1);
        font-size: 15px;
        transition: all 0.2s ease;
        flex-shrink: 0;
    }
    .icon-btn:hover { background: var(--bg-3); color: var(--accent); border-color: var(--border-1); }
    .icon-btn:active { transform: scale(0.95); }

    /* ===== Content ===== */
    .content { 
        padding: 32px; 
        padding-bottom: calc(32px + env(safe-area-inset-bottom));
        flex: 1; 
        max-width: 1440px; 
        width: 100%; 
        margin: 0 auto; 
    }

    /* ===== Page Header ===== */
    .page-header {
        display: flex; justify-content: space-between; align-items: flex-end;
        gap: 20px; flex-wrap: wrap;
        margin-bottom: 32px;
    }
    .page-title {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 32px; font-weight: 700; color: var(--text-0);
        letter-spacing: -1.2px;
        margin-bottom: 6px;
        line-height: 1.1;
        background: linear-gradient(135deg, #ffffff 0%, #ff5555 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }
    .page-subtitle {
        font-size: 13.5px; color: var(--text-2); font-weight: 500;
    }

    /* ===== Buttons ===== */
    .btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        padding: 11px 20px;
        border-radius: 11px;
        font-weight: 700;
        font-size: 13px;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        cursor: pointer;
        white-space: nowrap;
        text-decoration: none;
        font-family: inherit;
        border: 1px solid transparent;
        letter-spacing: 0.1px;
        min-height: 42px;
        user-select: none;
    }
    .btn:active { transform: scale(0.97); }

    .btn-primary {
        background: linear-gradient(135deg, var(--red-1), var(--red-2));
        color: #fff;
        box-shadow: 0 4px 20px rgba(255,59,59,0.3), inset 0 1px 0 rgba(255,255,255,0.2);
    }
    .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 32px rgba(255,59,59,0.5), inset 0 1px 0 rgba(255,255,255,0.3);
    }

    .btn-secondary {
        background: var(--bg-2);
        color: var(--text-0);
        border-color: var(--border-1);
    }
    .btn-secondary:hover { background: var(--bg-3); border-color: var(--border-2); transform: translateY(-2px); }

    .btn-danger {
        background: rgba(255,59,59,0.08);
        color: #ff5555;
        border-color: rgba(255,59,59,0.2);
    }
    .btn-danger:hover { 
        background: rgba(255,59,59,0.15); 
        border-color: rgba(255,59,59,0.4);
        transform: translateY(-2px);
    }

    .btn-ghost {
        background: transparent;
        color: var(--text-1);
        border-color: var(--border-1);
    }
    .btn-ghost:hover { 
        background: var(--bg-2); 
        color: var(--text-0); 
        border-color: var(--border-2); 
    }

    .btn-sm { padding: 9px 14px; font-size: 12.5px; border-radius: 9px; min-height: 38px; }
    .btn-block { width: 100%; }

    /* ===== Stats ===== */
    .stats-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-bottom: 32px;
    }
    .stat {
        position: relative;
        background: linear-gradient(180deg, var(--bg-1), var(--bg-0));
        border: 1px solid var(--border-0);
        border-radius: 16px;
        padding: 20px 22px;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
    }
    .stat::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,59,59,0.4), transparent);
    }
    .stat:hover {
        border-color: var(--border-1);
        transform: translateY(-2px);
        box-shadow: 0 20px 40px rgba(0,0,0,0.4), 0 0 30px rgba(255,59,59,0.08);
    }
    .stat-icon {
        width: 40px; height: 40px;
        border-radius: 11px;
        background: linear-gradient(135deg, var(--red-1), var(--red-2));
        color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-size: 18px;
        margin-bottom: 16px;
        box-shadow: 0 6px 20px rgba(255,59,59,0.3);
    }
    .stat-label {
        font-size: 12px; font-weight: 700; color: var(--text-2);
        margin-bottom: 6px;
        letter-spacing: 0.3px;
    }
    .stat-value {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 30px; font-weight: 700; color: var(--text-0);
        letter-spacing: -1.2px;
        line-height: 1.1;
    }
    .stat-value-sm { font-size: 22px; letter-spacing: -0.5px; }

    /* ===== Scripts Grid ===== */
    .scripts-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 16px;
    }
    .script-card {
        position: relative;
        background: linear-gradient(180deg, var(--bg-1), var(--bg-0));
        border: 1px solid var(--border-0);
        border-radius: 16px;
        padding: 22px;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow: hidden;
    }
    .script-card::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,59,59,0.4), transparent);
    }
    .script-card:hover {
        border-color: var(--border-1);
        background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
        transform: translateY(-3px);
        box-shadow: 0 24px 48px rgba(0,0,0,0.5), 0 0 40px rgba(255,59,59,0.12);
    }

    .script-card-header {
        display: flex; justify-content: space-between; align-items: flex-start;
        gap: 12px;
    }
    .script-card-icon {
        width: 44px; height: 44px;
        border-radius: 12px;
        background: linear-gradient(135deg, var(--red-1), var(--red-2));
        display: flex; align-items: center; justify-content: center;
        font-size: 19px;
        flex-shrink: 0;
        box-shadow: 0 6px 20px rgba(255,59,59,0.3);
    }
    .script-card-info { flex: 1; min-width: 0; padding-top: 2px; }
    .script-card-name {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 16px; font-weight: 700; color: var(--text-0);
        letter-spacing: -0.3px;
        margin-bottom: 6px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .script-card-meta {
        font-size: 11.5px; color: var(--text-2); font-weight: 600;
        display: flex; align-items: center; gap: 8px;
        flex-wrap: wrap;
    }
    .badge {
        display: inline-flex; align-items: center;
        padding: 3px 10px;
        border-radius: 7px;
        font-size: 10px; font-weight: 800;
        letter-spacing: 0.4px;
        border: 1px solid transparent;
    }
    .badge-version {
        background: rgba(184,85,255,0.12);
        color: #c490ff;
        border-color: rgba(184,85,255,0.25);
    }
    .badge-admin {
        background: rgba(255,170,0,0.12);
        color: #ffbb44;
        border-color: rgba(255,170,0,0.25);
    }
    .badge-user {
        background: var(--accent-dim);
        color: var(--accent-bright);
        border-color: rgba(255,59,59,0.25);
    }

    .script-card-url {
        background: var(--bg-0);
        border: 1px solid var(--border-0);
        border-radius: 10px;
        padding: 12px 14px;
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 10.5px;
        color: var(--accent-bright);
        word-break: break-all;
        line-height: 1.6;
        transition: border-color 0.2s ease;
    }
    .script-card-url:hover { border-color: var(--border-1); }

    .script-card-actions {
        display: flex; gap: 8px; flex-wrap: wrap;
        padding-top: 6px;
    }
    .script-card-actions .btn { flex: 1; min-width: calc(50% - 5px); }

    /* ===== Empty ===== */
    .empty {
        background: linear-gradient(180deg, var(--bg-1), var(--bg-0));
        border: 1px dashed var(--border-1);
        border-radius: 16px;
        padding: 70px 30px;
        text-align: center;
    }
    .empty-icon {
        width: 76px; height: 76px;
        border-radius: 20px;
        background: var(--bg-2);
        border: 1px solid var(--border-0);
        display: flex; align-items: center; justify-content: center;
        font-size: 34px;
        margin: 0 auto 20px;
    }
    .empty-title { 
        font-family: 'Space Grotesk', sans-serif;
        font-size: 18px; font-weight: 700; color: var(--text-0); 
        margin-bottom: 8px; 
        letter-spacing: -0.3px; 
    }
    .empty-desc { font-size: 13.5px; color: var(--text-2); margin-bottom: 24px; }

    /* ===== Card / Form ===== */
    .card {
        position: relative;
        background: linear-gradient(180deg, var(--bg-1), var(--bg-0));
        border: 1px solid var(--border-0);
        border-radius: 16px;
        padding: 30px;
        overflow: hidden;
    }
    .card::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,59,59,0.4), transparent);
    }
    .form-group { margin-bottom: 20px; }
    .form-label {
        display: block;
        font-size: 12px; font-weight: 700; color: var(--text-1);
        margin-bottom: 9px;
        letter-spacing: 0.4px;
        text-transform: uppercase;
    }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 20px; }
    input, textarea, select {
        width: 100%;
        padding: 13px 15px;
        background: var(--bg-0);
        border: 1px solid var(--border-0);
        border-radius: 11px;
        color: var(--text-0);
        font-size: 15px;
        font-family: inherit;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        outline: none;
        min-height: 48px;
    }
    input:focus, textarea:focus, select:focus {
        border-color: var(--accent);
        background: var(--bg-1);
        box-shadow: 0 0 0 3px var(--accent-dim), 0 0 20px rgba(255,59,59,0.1);
    }
    input::placeholder, textarea::placeholder { color: var(--text-3); }
    textarea {
        font-family: 'JetBrains Mono', 'Consolas', monospace;
        font-size: 12.5px;
        line-height: 1.65;
        resize: vertical;
        min-height: 300px;
    }
    select {
        cursor: pointer;
        background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a8a8a' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'/%3e%3c/svg%3e");
        background-repeat: no-repeat;
        background-position: right 14px center;
        background-size: 16px;
        padding-right: 42px;
    }

    /* ===== User List ===== */
    .user-row {
        position: relative;
        background: linear-gradient(180deg, var(--bg-1), var(--bg-0));
        border: 1px solid var(--border-0);
        border-radius: 14px;
        padding: 16px 20px;
        display: flex; align-items: center; gap: 14px;
        margin-bottom: 10px;
        transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
    }
    .user-row:hover {
        border-color: var(--border-1);
        background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
        transform: translateX(3px);
        box-shadow: 0 12px 28px rgba(0,0,0,0.35), 0 0 20px rgba(255,59,59,0.08);
    }
    .user-row .user-avatar { width: 44px; height: 44px; border-radius: 12px; font-size: 17px; }
    .user-row-info { flex: 1; min-width: 0; }
    .user-row-name {
        font-family: 'Space Grotesk', sans-serif;
        font-size: 15px; font-weight: 700; color: var(--text-0);
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 4px;
        flex-wrap: wrap;
    }
    .user-row-meta { font-size: 12px; color: var(--text-2); font-weight: 500; }

    /* ===== Toast ===== */
    @keyframes toastIn {
        from { transform: translateX(400px) scale(0.9); opacity: 0; }
        to { transform: translateX(0) scale(1); opacity: 1; }
    }
    @keyframes toastOut {
        to { transform: translateX(400px) scale(0.9); opacity: 0; }
    }
    .toast {
        position: fixed; 
        bottom: calc(24px + env(safe-area-inset-bottom)); 
        right: 24px;
        background: var(--bg-2);
        border: 1px solid var(--border-1);
        color: var(--text-0);
        padding: 14px 20px;
        border-radius: 12px;
        font-weight: 600;
        font-size: 13.5px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.6);
        z-index: 9999;
        display: flex; align-items: center; gap: 12px;
        animation: toastIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
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
        background: var(--red-1); 
        box-shadow: 0 0 16px var(--accent-glow); 
    }
    .toast.error::before { 
        background: #ffb800; 
        box-shadow: 0 0 16px rgba(255,184,0,0.5); 
    }
    .toast.error { border-color: rgba(255,184,0,0.3); }

    /* ===== Login ===== */
    .login-wrap {
        min-height: 100vh;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        padding-top: calc(20px + env(safe-area-inset-top));
        padding-bottom: calc(20px + env(safe-area-inset-bottom));
        position: relative;
    }
    .login-card {
        position: relative;
        background: rgba(15,8,8,0.7);
        backdrop-filter: blur(30px) saturate(180%);
        -webkit-backdrop-filter: blur(30px) saturate(180%);
        border: 1px solid var(--border-1);
        border-radius: 22px;
        padding: 44px 40px;
        width: 420px;
        max-width: 100%;
        box-shadow: 0 40px 100px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .login-card::before {
        content: '';
        position: absolute;
        top: 0; left: 50%;
        transform: translateX(-50%);
        width: 60%; height: 1px;
        background: linear-gradient(90deg, transparent, var(--red-1), transparent);
        opacity: 0.8;
    }
    .login-brand {
        display: flex; flex-direction: column; align-items: center;
        margin-bottom: 32px;
        text-align: center;
    }
    .login-logo {
        width: 72px; height: 72px;
        border-radius: 20px;
        background: linear-gradient(135deg, var(--red-1), var(--red-2));
        display: flex; align-items: center; justify-content: center;
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700; font-size: 28px; color: #fff;
        margin-bottom: 18px;
        box-shadow: 0 16px 48px var(--accent-glow), inset 0 2px 0 rgba(255,255,255,0.2);
    }
    .login-title { 
        font-family: 'Space Grotesk', sans-serif;
        font-size: 26px; font-weight: 700; color: var(--text-0);
        letter-spacing: -0.8px; 
        margin-bottom: 6px; 
    }
    .login-sub { font-size: 13.5px; color: var(--text-2); font-weight: 500; }
    .login-card input { margin-bottom: 13px; padding: 14px 16px; }
    .login-card .btn-primary { width: 100%; padding: 15px; font-size: 14.5px; margin-top: 8px; }
    .login-msg { margin-top: 16px; text-align: center; font-size: 12.5px; font-weight: 600; min-height: 18px; }
    .login-msg.error { color: #ff5555; }
    .login-msg.success { color: #22c55e; }
    .login-link { 
        display: block; 
        text-align: center; 
        margin-top: 22px; 
        font-size: 13.5px; 
        color: var(--red-1); 
        font-weight: 700;
        transition: opacity 0.2s;
    }
    .login-link:hover { opacity: 0.8; text-decoration: underline; }

    /* ===== Mobile Menu Button ===== */
    .menu-btn {
        display: none;
        width: 42px; height: 42px;
        border-radius: 11px;
        background: var(--bg-2);
        border: 1px solid var(--border-0);
        align-items: center; justify-content: center;
        color: var(--text-1);
        font-size: 18px;
        cursor: pointer;
        transition: all 0.2s ease;
        flex-shrink: 0;
    }
    .menu-btn:hover { background: var(--bg-3); color: var(--accent); }
    .menu-btn:active { transform: scale(0.95); }

    /* ===== Overlay ===== */
    .overlay {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.75);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 45;
        animation: fadeIn 0.25s ease;
    }
    .overlay.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    /* ===== Scrollbar ===== */
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { 
        background: var(--border-1); 
        border-radius: 5px; 
        border: 2px solid var(--bg-0); 
    }
    ::-webkit-scrollbar-thumb:hover { background: var(--border-2); }

    /* =============================================
       TABLET (768px - 900px)
       ============================================= */
    @media (max-width: 900px) {
        .sidebar { 
            transform: translateX(-100%); 
            width: 280px;
        }
        .sidebar.open { 
            transform: translateX(0); 
            box-shadow: 40px 0 100px rgba(0,0,0,0.8); 
        }
        .main { margin-left: 0; }
        .menu-btn { display: flex; }
        .content { padding: 24px; }
        .topbar { padding: 0 24px; }
        .page-title { font-size: 28px; }
        .scripts-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
        .stats-row { grid-template-columns: repeat(2, 1fr); }
    }

    /* =============================================
       MOBILE (480px - 768px)
       ============================================= */
    @media (max-width: 768px) {
        body { font-size: 14px; }
        .content { padding: 18px; }
        .topbar { padding: 0 18px; height: 60px; }
        .page-header { margin-bottom: 22px; flex-direction: column; align-items: stretch; gap: 16px; }
        .page-title { font-size: 24px; letter-spacing: -0.8px; }
        .page-subtitle { font-size: 13px; }
        .card { padding: 22px; }
        .stat { padding: 18px 20px; }
        .stat-value { font-size: 26px; }
        .script-card { padding: 20px; }
        .script-card-name { font-size: 15.5px; }
        .form-row { grid-template-columns: 1fr; gap: 0; }
        .scripts-grid { grid-template-columns: 1fr; gap: 14px; }
        .stats-row { grid-template-columns: 1fr 1fr; gap: 12px; }
        .btn { padding: 12px 18px; font-size: 13.5px; }
        .btn-sm { padding: 10px 14px; font-size: 12.5px; }
        textarea { min-height: 260px; font-size: 12px; }
        .login-card { padding: 36px 28px; }
        .login-logo { width: 64px; height: 64px; font-size: 24px; border-radius: 18px; }
        .login-title { font-size: 22px; }
        .user-row { padding: 14px 16px; }
        .user-row-name { font-size: 14px; }
    }

    /* =============================================
       SMALL MOBILE (under 480px)
       ============================================= */
    @media (max-width: 480px) {
        .content { padding: 14px; }
        .topbar { padding: 0 14px; height: 58px; }
        .page-title { font-size: 22px; }
        .page-header { margin-bottom: 18px; }
        .card { padding: 18px; border-radius: 14px; }
        .stat { padding: 16px 16px; border-radius: 14px; }
        .stat-value { font-size: 22px; }
        .stat-value-sm { font-size: 18px; }
        .stat-icon { width: 36px; height: 36px; font-size: 16px; margin-bottom: 12px; }
        .script-card { padding: 16px; border-radius: 14px; }
        .script-card-icon { width: 40px; height: 40px; font-size: 17px; border-radius: 11px; }
        .script-card-name { font-size: 15px; }
        .script-card-actions .btn { flex: 1; min-width: 100%; }
        .script-card-actions { flex-direction: column; }
        .stats-row { grid-template-columns: 1fr; gap: 10px; }
        input, textarea, select { font-size: 16px; padding: 12px 14px; }
        textarea { min-height: 220px; font-size: 12px; }
        .login-card { padding: 30px 22px; border-radius: 18px; }
        .login-logo { width: 58px; height: 58px; font-size: 22px; border-radius: 16px; margin-bottom: 14px; }
        .login-title { font-size: 20px; }
        .login-sub { font-size: 12.5px; }
        .empty { padding: 50px 20px; }
        .empty-icon { width: 64px; height: 64px; font-size: 28px; }
        .empty-title { font-size: 16px; }
        .user-row { flex-direction: column; align-items: flex-start; gap: 12px; }
        .user-row .btn { align-self: stretch; }
        .toast { left: 14px; right: 14px; bottom: calc(14px + env(safe-area-inset-bottom)); font-size: 13px; padding: 13px 16px; }
    }

    /* =============================================
       LANDSCAPE MOBILE
       ============================================= */
    @media (max-width: 900px) and (orientation: landscape) {
        .content { padding: 16px; }
        .page-header { margin-bottom: 16px; }
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
            if (btn) { 
                const o = btn.innerHTML; 
                btn.innerHTML = '✓ Copied'; 
                setTimeout(() => btn.innerHTML = o, 1400); 
            }
            showToast('Copied to clipboard', 'success');
        }).catch(() => showToast('Failed to copy', 'error'));
    }
    function confirmDelete(token, name) {
        if (confirm('Delete "' + name + '"?')) window.location.href = '/delete/' + token;
    }
    function toggleSidebar() {
        document.querySelector('.sidebar').classList.toggle('open');
        document.querySelector('.overlay').classList.toggle('active');
        document.body.style.overflow = document.querySelector('.sidebar').classList.contains('open') ? 'hidden' : '';
    }
    // Close sidebar on nav click (mobile)
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 900) {
                document.querySelector('.sidebar').classList.remove('open');
                document.querySelector('.overlay').classList.remove('active');
                document.body.style.overflow = '';
            }
        });
    });
`;

// ==================== LAYOUT ====================
function renderLayout({ title, pageTitle, pageSubtitle, content, user, activeNav, actions }) {
    const isAdmin = user.role === 'ADMIN';
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>${getHtmlHead(title)}<style>${LAYOUT_STYLES}</style></head>
    <body>
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
                        <button class="menu-btn" onclick="toggleSidebar()" aria-label="Menu">☰</button>
                        <div class="topbar-title">${pageTitle}</div>
                    </div>
                    <div class="topbar-right">
                        <a href="/logout" class="icon-btn" title="Logout" aria-label="Logout">⏻</a>
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
        <div class="login-wrap">
            <div class="login-card">
                <div class="login-brand">
                    <div class="login-logo">ZK</div>
                    <div class="login-title">Welcome back</div>
                    <div class="login-sub">Sign in to continue to ${BRAND_SHORT}</div>
                </div>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required autofocus autocomplete="username">
                    <input type="password" name="password" placeholder="Password" required autocomplete="current-password">
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
                    <div class="stat-value stat-value-sm">${isAdmin ? 'Admin' : 'Member'}</div>
                </div>
                <div class="stat">
                    <div class="stat-icon">◉</div>
                    <div class="stat-label">Username</div>
                    <div class="stat-value stat-value-sm">${req.session.user.username}</div>
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
                        <button type="submit" class="btn btn-primary">Save Changes</button>
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
            <div class="login-wrap">
                <div class="login-card" style="width:640px;text-align:center;">
                    <div class="login-brand" style="margin-bottom:24px;">
                        <div class="login-logo">ZK</div>
                        <div class="login-title">${script.name}</div>
                        <div class="login-sub" style="display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;margin-top:10px;">
                            <span class="badge badge-version">${script.version}</span>
                            <span style="color:var(--text-2);font-size:12px;font-weight:600;">Protected Script</span>
                        </div>
                    </div>
                    <div style="background:var(--bg-0);border:1px solid var(--border-0);border-radius:12px;padding:18px;margin-bottom:18px;text-align:left;">
                        <div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:12px;">Loadstring</div>
                        <div id="lsBox" style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--accent-bright);word-break:break-all;line-height:1.8;">${loadstring}</div>
                    </div>
                    <button class="btn btn-primary btn-block" style="padding:15px;font-size:14.5px;" onclick="copyText(document.getElementById('lsBox').innerText, this)">📋 Copy Loadstring</button>
                    <div style="margin-top:24px;font-size:11px;color:var(--text-3);font-weight:600;letter-spacing:0.6px;">Protected by ${BRAND_NAME}</div>
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
                <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
                    <div class="user-avatar ${targetUserData.role === 'ADMIN' ? 'user-avatar-admin' : ''}" style="width:56px;height:56px;border-radius:16px;font-size:22px;">${targetUser.charAt(0)}</div>
                    <div style="flex:1;min-width:200px;">
                        <div style="font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:700;color:var(--text-0);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                            ${targetUser}
                            <span class="badge ${targetUserData.role === 'ADMIN' ? 'badge-admin' : 'badge-user'}">${targetUserData.role}</span>
                        </div>
                        <div style="font-size:12.5px;color:var(--text-2);margin-top:4px;">Joined ${new Date(targetUserData.created_at).toLocaleDateString()}</div>
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
    console.log(`✅ ${BRAND_NAME} v27.0 — PC + CP Optimized`);
    console.log(`📱 Responsive design for desktop & mobile`);
});
