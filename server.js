const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== POSTGRES CONNECTION ====================
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
                await pool.query(
                    'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
                    ['Z-K', adminPass, 'ADMIN']
                );
                console.log('👑 Admin account "Z-K" created.');
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
    secret: process.env.SESSION_SECRET || 'shieldhub-secret-key',
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
    else res.status(403).send('Access Denied: Admin only');
}

// ==================== FAVICON & LOGO ROUTES (Serve as separate files) ====================
const LOGO_SVG_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs>
<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" style="stop-color:#00ff88;stop-opacity:1" />
<stop offset="100%" style="stop-color:#00aa55;stop-opacity:1" />
</linearGradient>
</defs>
<path d="M50 5 L85 20 L85 50 C85 75 70 90 50 95 C30 90 15 75 15 50 L15 20 Z" fill="url(#grad)" stroke="#006633" stroke-width="2"/>
<path d="M50 30 L65 40 L60 55 C58 62 54 67 50 70 C46 67 42 62 40 55 L35 40 Z" fill="#0a0a0a"/>
<circle cx="50" cy="48" r="5" fill="#00ff88"/>
</svg>`;

const FAVICON_SVG_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs>
<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" style="stop-color:#00ff88;stop-opacity:1" />
<stop offset="100%" style="stop-color:#00aa55;stop-opacity:1" />
</linearGradient>
</defs>
<path d="M50 5 L85 20 L85 50 C85 75 70 90 50 95 C30 90 15 75 15 50 L15 20 Z" fill="url(#grad)"/>
<circle cx="50" cy="48" r="14" fill="#0a0a0a"/>
<path d="M42 38 L58 44 L54 56 C52 61 49 64 47 66 L42 56 Z" fill="#00ff88"/>
</svg>`;

// Serve logo as PNG-like image
app.get('/logo.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(LOGO_SVG_CONTENT);
});

// Serve favicon
app.get('/favicon.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(FAVICON_SVG_CONTENT);
});

app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(FAVICON_SVG_CONTENT);
});

// ==================== OBFUSCATION ====================
function obfuscateScript(code) {
    const encoded = Buffer.from(code, 'utf8').toString('base64');
    return `
-- ShieldHub Protected v13.0
local _b="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local _d="${encoded}"
local _o={}
_d:gsub(".", function(_c) local _n=_b:find(_c,1,true) if _n then _o[#_o+1]=_n-1 end end)
local _r=""
for _i=1,#_o,4 do
    local _n=_o[_i]*262144+(_o[_i+1] or 0)*4096+(_o[_i+2] or 0)*64+(_o[_i+3] or 0)
    _r=_r..string.char(math.floor(_n/65536)%256)
    if _o[_i+2] then _r=_r..string.char(math.floor(_n/256)%256) end
    if _o[_i+3] then _r=_r..string.char(_n%256) end
end
local _f=loadstring(_r)
if _f then _f() end
`;
}

function makeSlug(name) {
    return name.toString().trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50) || 'Script';
}

function versionDropdown(selectedValue) {
    let options = '';
    for (let i = 1; i <= 1000; i++) {
        const v = 'V' + i;
        const selected = (v === selectedValue) ? 'selected' : '';
        options += `<option value="${v}" ${selected}>${v}</option>`;
    }
    return options;
}

// HTML head generator para sa lahat ng pages
function getHtmlHead(title) {
    return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${title}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="alternate icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="apple-touch-icon" href="/favicon.svg">
    <meta name="theme-color" content="#00ff88">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black">
    <meta name="apple-mobile-web-app-title" content="ShieldHub">
    <meta name="application-name" content="ShieldHub">
    `;
}

// ==================== SHARED STYLES ====================
const SHARED_STYLES = `
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html { font-size: 16px; }
    body { 
        background: #0a0a0a; color: #e0e0e0; 
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
        padding: 20px; min-height: 100vh;
        background: radial-gradient(circle at top left, #0f1f15 0%, #0a0a0a 40%);
        overflow-x: hidden;
    }
    .header { display: flex; justify-content: space-between; align-items: center; background: rgba(17,17,17,0.85); backdrop-filter: blur(10px); padding: 18px 25px; border-radius: 16px; border: 1px solid #222; flex-wrap: wrap; gap: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); margin-bottom: 20px; }
    .header-brand { display: flex; align-items: center; gap: 12px; }
    .header-logo { width: 42px; height: 42px; filter: drop-shadow(0 0 10px rgba(0, 255, 136, 0.4)); flex-shrink: 0; }
    .header-title { font-size: 22px; color: #00ff88; font-weight: 800; letter-spacing: -0.5px; text-shadow: 0 0 20px rgba(0, 255, 136, 0.3); }
    .header-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .username { color: #ccc; font-weight: 600; font-size: 14px; }
    .badge { background: #00ff88; color: #000; padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; }
    .badge-admin { background: linear-gradient(135deg, #ffaa00, #ff6600); color: #000; }
    .btn { background: linear-gradient(135deg, #00ff88, #00cc66); color: #000; padding: 11px 20px; border: none; border-radius: 10px; cursor: pointer; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-size: 14px; transition: all 0.2s ease; font-family: inherit; white-space: nowrap; }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0, 255, 136, 0.4); }
    .btn-red { background: linear-gradient(135deg, #ff4444, #cc0000); color: #fff; }
    .btn-red:hover { box-shadow: 0 6px 20px rgba(255, 68, 68, 0.4); }
    .btn-orange { background: linear-gradient(135deg, #ffaa00, #ff8800); color: #000; }
    .btn-orange:hover { box-shadow: 0 6px 20px rgba(255, 170, 0, 0.4); }
    .btn-blue { background: linear-gradient(135deg, #0088ff, #0066cc); color: #fff; }
    .btn-blue:hover { box-shadow: 0 6px 20px rgba(0, 136, 255, 0.4); }
    .btn-purple { background: linear-gradient(135deg, #aa44ff, #8800cc); color: #fff; }
    .btn-purple:hover { box-shadow: 0 6px 20px rgba(170, 68, 255, 0.4); }
    .card { background: linear-gradient(135deg, #1a1a1a 0%, #151515 100%); padding: 25px; border-radius: 16px; margin: 20px 0; border: 1px solid #222; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    .form-group { margin-bottom: 20px; }
    .form-label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 0.8px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    input, textarea, select { width: 100%; padding: 14px 16px; background: #0a0a0a; border: 2px solid #2a2a2a; color: #fff; border-radius: 10px; font-size: 14px; font-family: inherit; transition: all 0.2s ease; outline: none; }
    input:focus, textarea:focus, select:focus { border-color: #00ff88; box-shadow: 0 0 0 4px rgba(0, 255, 136, 0.1); }
    textarea { font-family: 'Consolas', 'Monaco', monospace; resize: vertical; min-height: 120px; line-height: 1.5; }
    select { cursor: pointer; appearance: none; background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2300ff88' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'/%3e%3c/svg%3e"); background-repeat: no-repeat; background-position: right 15px center; background-size: 20px; padding-right: 45px; }
    .section-title { font-size: 20px; font-weight: 800; color: #fff; margin: 30px 0 15px 0; display: flex; align-items: center; gap: 10px; letter-spacing: -0.5px; }
    .version-badge { background: linear-gradient(135deg, #aa44ff, #8800cc); color: #fff; padding: 4px 12px; border-radius: 8px; font-size: 11px; font-weight: 800; margin-left: 8px; }
    .url-preview { background: #0a0a0a; border: 1px solid #2a2a2a; padding: 12px 16px; border-radius: 10px; font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; color: #00ff88; word-break: break-all; margin: 10px 0; line-height: 1.5; }
    .script-card { background: linear-gradient(135deg, #1a1a1a 0%, #151515 100%); padding: 25px; border-radius: 16px; margin: 15px 0; border: 1px solid #222; transition: all 0.2s ease; }
    .script-card:hover { border-color: #00ff88; transform: translateY(-2px); }
    .script-card h3 { font-size: 18px; color: #fff; margin-bottom: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-weight: 700; }
    .script-meta { color: #666; font-size: 12px; margin-bottom: 15px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 15px; }
    .empty-state { text-align: center; padding: 50px 20px; color: #666; }
    .empty-state-icon { font-size: 64px; margin-bottom: 20px; opacity: 0.4; }

    .user-card { background: linear-gradient(135deg, #1a1a1a 0%, #151515 100%); padding: 20px 25px; border-radius: 14px; margin: 12px 0; border: 1px solid #222; display: flex; justify-content: space-between; align-items: center; gap: 15px; flex-wrap: wrap; transition: all 0.2s ease; text-decoration: none; color: inherit; }
    .user-card:hover { border-color: #aa44ff; transform: translateY(-2px); box-shadow: 0 10px 30px rgba(170, 68, 255, 0.15); }
    .user-info { display: flex; align-items: center; gap: 15px; flex: 1; min-width: 200px; }
    .user-avatar { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #00ff88, #00cc66); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; color: #000; flex-shrink: 0; text-transform: uppercase; }
    .user-avatar-admin { background: linear-gradient(135deg, #ffaa00, #ff6600); }
    .user-details { display: flex; flex-direction: column; gap: 4px; }
    .user-name { font-weight: 700; font-size: 16px; color: #fff; }
    .user-meta { font-size: 12px; color: #666; }
    .role-tag { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
    .role-admin-tag { background: linear-gradient(135deg, #ffaa00, #ff6600); color: #000; }
    .role-user-tag { background: #00ff88; color: #000; }

    @keyframes slideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes fadeOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(400px); } }
    .toast { position: fixed; bottom: 30px; right: 30px; background: linear-gradient(135deg, #00ff88, #00cc66); color: #000; padding: 16px 24px; border-radius: 12px; font-weight: 700; font-size: 14px; box-shadow: 0 10px 30px rgba(0, 255, 136, 0.4); z-index: 9999; display: flex; align-items: center; gap: 10px; animation: slideIn 0.3s ease; max-width: 90vw; }
    .toast.hiding { animation: fadeOut 0.3s ease forwards; }

    @media (max-width: 768px) {
        body { padding: 12px; }
        .header { padding: 15px 18px; }
        .header-title { font-size: 18px; }
        .header-logo { width: 36px; height: 36px; }
        .form-row { grid-template-columns: 1fr; gap: 15px; }
        .card { padding: 20px; }
        .script-card { padding: 20px; }
        .section-title { font-size: 18px; }
        .btn { padding: 10px 16px; font-size: 13px; }
        .toast { bottom: 15px; right: 15px; left: 15px; padding: 14px 18px; font-size: 13px; }
        .user-card { padding: 16px 18px; }
    }
    @media (max-width: 480px) {
        body { padding: 8px; }
        .header { padding: 12px 15px; border-radius: 12px; }
        .header-title { font-size: 16px; }
        .header-logo { width: 32px; height: 32px; }
        .header-right { width: 100%; justify-content: space-between; }
        .card { padding: 16px; border-radius: 12px; }
        .script-card { padding: 16px; border-radius: 12px; }
        .script-card h3 { font-size: 16px; }
        .section-title { font-size: 16px; }
        .btn { padding: 10px 14px; font-size: 12px; }
        .actions .btn { flex: 1; min-width: calc(50% - 4px); }
        input, textarea, select { padding: 12px 14px; font-size: 14px; }
        .empty-state-icon { font-size: 48px; }
        .user-card { padding: 14px 15px; }
        .user-avatar { width: 42px; height: 42px; font-size: 18px; }
        .user-name { font-size: 14px; }
    }

    .login-container { background: linear-gradient(135deg, #1a1a1a 0%, #111 100%); padding: 50px 40px; border-radius: 20px; border: 1px solid #222; width: 420px; max-width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.6); position: relative; overflow: hidden; }
    .login-container::before { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(circle, rgba(0,255,136,0.08) 0%, transparent 70%); animation: pulse 4s ease-in-out infinite; pointer-events: none; }
    @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.5; } 50% { transform: scale(1.2); opacity: 0.8; } }
    .login-container h1 { color: #00ff88; font-size: 32px; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 12px; position: relative; z-index: 1; font-weight: 800; letter-spacing: -1px; text-shadow: 0 0 30px rgba(0, 255, 136, 0.4); }
    .login-logo { width: 48px; height: 48px; filter: drop-shadow(0 0 15px rgba(0, 255, 136, 0.6)); animation: float 3s ease-in-out infinite; }
    @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
    .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; position: relative; z-index: 1; }
    .login-container input { margin-bottom: 15px; text-align: center; position: relative; z-index: 1; }
    .login-container .btn { width: 100%; margin-top: 10px; position: relative; z-index: 1; }
    .msg { margin-top: 15px; font-size: 13px; position: relative; z-index: 1; }
    .error { color: #ff4444; }
    .success { color: #00ff88; }
    .link { color: #00ff88; text-decoration: none; display: block; margin-top: 20px; font-size: 14px; position: relative; z-index: 1; font-weight: 600; }
    .link:hover { text-decoration: underline; }
    @media (max-width: 480px) { .login-container { padding: 40px 25px; border-radius: 16px; } .login-container h1 { font-size: 26px; } .login-logo { width: 40px; height: 40px; } }
`;

// ==================== TOAST SCRIPT ====================
const TOAST_SCRIPT = `
    function showToast(message, type = 'success') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = '<span>' + (type === 'success' ? '✅' : '❌') + '</span><span>' + message + '</span>';
        if (type === 'error') {
            toast.style.background = 'linear-gradient(135deg, #ff4444, #cc0000)';
            toast.style.color = '#fff';
        }
        document.body.appendChild(toast);
        setTimeout(() => { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); }, 2500);
    }
    function copyLoadstring(url, btn) {
        const loadstring = 'loadstring(game:HttpGet("' + url + '"))()';
        navigator.clipboard.writeText(loadstring).then(() => {
            if (btn) {
                const original = btn.innerHTML;
                btn.innerHTML = '✅ Copied!';
                btn.style.background = 'linear-gradient(135deg, #00cc66, #009944)';
                setTimeout(() => { btn.innerHTML = original; btn.style.background = ''; }, 1800);
            }
            showToast('Loadstring copied!');
        }).catch(() => showToast('Failed to copy!', 'error'));
    }
    function confirmDelete(token, name) {
        if (confirm('⚠️ Are you sure you want to delete "' + name + '"?')) {
            window.location.href = '/delete/' + token;
        }
    }
`;

// ==================== LOGIN ====================
app.get('/login', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        ${getHtmlHead('ShieldHub - Login')}
        <style>${SHARED_STYLES} body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }</style>
    </head>
    <body>
        <div class="login-container">
            <h1><img src="/logo.svg" class="login-logo" alt="ShieldHub"> ShieldHub</h1>
            <p class="subtitle">Login to your dashboard</p>
            <form action="/login" method="POST">
                <input type="text" name="username" placeholder="Username" required autocomplete="username">
                <input type="password" name="password" placeholder="Password" required autocomplete="current-password">
                <button type="submit" class="btn">🔓 Login</button>
            </form>
            <p class="msg error">${req.query.error ? '❌ Invalid name or password!' : ''}</p>
            <p class="msg success">${req.query.registered ? '✅ Account created! Please login.' : ''}</p>
            <a href="/register" class="link">Create new account →</a>
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
    } catch (e) { console.error(e); res.redirect('/login?error=1'); }
});

// ==================== REGISTER ====================
app.get('/register', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        ${getHtmlHead('ShieldHub - Register')}
        <style>${SHARED_STYLES} body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }</style>
    </head>
    <body>
        <div class="login-container">
            <h1><img src="/logo.svg" class="login-logo" alt="ShieldHub"> ShieldHub</h1>
            <p class="subtitle">Create your account</p>
            <form action="/register" method="POST">
                <input type="text" name="username" placeholder="Username" required>
                <input type="password" name="password" placeholder="Password" required>
                <input type="password" name="confirmPassword" placeholder="Confirm Password" required>
                <button type="submit" class="btn">✨ Register</button>
            </form>
            <p class="msg error">${req.query.error || ''}</p>
            <a href="/login" class="link">← Back to login</a>
        </div>
    </body>
    </html>
    `);
});

app.post('/register', async (req, res) => {
    try {
        const { username, password, confirmPassword } = req.body;
        if (password !== confirmPassword) return res.redirect('/register?error=Passwords do not match!');
        if (username.length < 2 || password.length < 4) return res.redirect('/register?error=Name min 2 chars, Password min 4 chars');
        const existing = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existing.rows.length > 0) return res.redirect('/register?error=Name already taken!');
        const role = username === 'Z-K' ? 'ADMIN' : 'USER';
        await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, password, role]);
        res.redirect('/login?registered=1');
    } catch (e) { console.error(e); res.redirect('/register?error=Server error'); }
});

// ==================== LOGOUT ====================
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==================== DASHBOARD ====================
app.get('/', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [req.session.user.username]);
        const myScripts = result.rows;
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const isAdmin = req.session.user.role === 'ADMIN';
        
        let html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            ${getHtmlHead('ShieldHub - Dashboard')}
            <style>${SHARED_STYLES}</style>
        </head>
        <body>
            <div class="header">
                <div class="header-brand">
                    <img src="/logo.svg" class="header-logo" alt="ShieldHub">
                    <span class="header-title">ShieldHub</span>
                </div>
                <div class="header-right">
                    <span class="username">${req.session.user.username}</span>
                    ${isAdmin ? '<span class="badge badge-admin">ADMIN</span>' : '<span class="badge">USER</span>'}
                    ${isAdmin ? '<a href="/admin" class="btn btn-purple">👑 Admin Panel</a>' : ''}
                    <a href="/logout" class="btn btn-red">Logout</a>
                </div>
            </div>

            <h2 class="section-title">✨ Create New Script</h2>
            <div class="card">
                <form action="/create" method="POST">
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">📝 Script Name</label>
                            <input type="text" name="name" placeholder="e.g., Bee Hub" required>
                        </div>
                        <div class="form-group">
                            <label class="form-label">🏷️ Version</label>
                            <select name="version" required>${versionDropdown('V1')}</select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">💻 Script Content (Lua Code)</label>
                        <textarea name="content" rows="10" placeholder="-- Paste your Lua script here..." required></textarea>
                    </div>
                    <button type="submit" class="btn">➕ Create Script</button>
                </form>
            </div>

            <h2 class="section-title">📁 Your Scripts (${myScripts.length})</h2>
        `;
        
        if (myScripts.length === 0) {
            html += `<div class="card empty-state"><div class="empty-state-icon">📭</div><p>No scripts yet. Create your first script above!</p></div>`;
        } else {
            myScripts.forEach(s => {
                const slug = s.slug || 'Script';
                const version = s.version || 'V1';
                const prettyUrl = `${baseUrl}/raw/${slug}/${version}/${s.token}`;
                html += `
                <div class="script-card">
                    <h3>📄 ${s.name} <span class="version-badge">${version}</span></h3>
                    <div class="script-meta">Created: ${new Date(s.created_at).toLocaleDateString()}</div>
                    <div class="url-preview">${prettyUrl}</div>
                    <div class="actions">
                        <button class="btn" onclick="copyLoadstring('${prettyUrl}', this)">📋 Copy Loadstring</button>
                        <a href="/edit/${s.token}" class="btn btn-orange">✏️ Edit</a>
                        <a href="/view/${slug}/${version}/${s.token}" class="btn btn-blue" target="_blank">👁️ View</a>
                        <button class="btn btn-red" onclick="confirmDelete('${s.token}', '${s.name}')">🗑️ Delete</button>
                    </div>
                </div>
                `;
            });
        }
        html += `<script>${TOAST_SCRIPT}</script></body></html>`;
        res.send(html);
    } catch (e) { 
        console.error('DASHBOARD ERROR:', e.message); 
        res.status(500).send('Server error: ' + e.message); 
    }
});

// ==================== CREATE ====================
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
    } catch (e) { 
        console.error('CREATE ERROR:', e.message); 
        res.status(500).send('Error creating script: ' + e.message); 
    }
});

// ==================== EDIT ====================
app.get('/edit/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Script not found");
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");

        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            ${getHtmlHead('Edit Script - ShieldHub')}
            <style>${SHARED_STYLES}</style>
        </head>
        <body>
            <div class="header">
                <div class="header-brand">
                    <img src="/logo.svg" class="header-logo" alt="ShieldHub">
                    <span class="header-title">Edit Script</span>
                </div>
                <a href="/" class="btn">← Back</a>
            </div>
            <div class="card">
                <form action="/edit/${script.token}" method="POST">
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">📝 Script Name</label>
                            <input type="text" name="name" value="${script.name}" required>
                        </div>
                        <div class="form-group">
                            <label class="form-label">🏷️ Version</label>
                            <select name="version" required>${versionDropdown(script.version)}</select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">💻 Script Content (Real Code)</label>
                        <textarea name="content" rows="20" required>${script.real_content}</textarea>
                    </div>
                    <button type="submit" class="btn">💾 Save Changes</button>
                </form>
            </div>
        </body>
        </html>
        `);
    } catch (e) { 
        console.error('EDIT ERROR:', e.message); 
        res.status(500).send('Server error: ' + e.message); 
    }
});

app.post('/edit/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Script not found");
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
    } catch (e) { 
        console.error('EDIT SAVE ERROR:', e.message); 
        res.status(500).send('Server error: ' + e.message); 
    }
});

// ==================== VIEW ====================
app.get('/view/:slug/:version/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Script not found");
        const script = result.rows[0];
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const prettyUrl = `${baseUrl}/raw/${script.slug}/${script.version}/${script.token}`;
        const loadstring = `loadstring(game:HttpGet("${prettyUrl}"))()`;
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            ${getHtmlHead('ShieldHub - ' + script.name)}
            <style>
                ${SHARED_STYLES}
                body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
                .view-container { background: linear-gradient(135deg, #1a1a1a 0%, #111 100%); padding: 50px 40px; border-radius: 20px; border: 1px solid #222; width: 500px; max-width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
                .view-container h1 { color: #00ff88; font-size: 32px; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 10px; }
                .view-logo { width: 40px; height: 40px; filter: drop-shadow(0 0 15px rgba(0, 255, 136, 0.6)); }
                .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
                .protected-box { border: 2px solid #ff4444; padding: 25px; border-radius: 12px; margin: 25px 0; background: rgba(255, 68, 68, 0.05); }
                .protected-box p { color: #ff4444; font-weight: 700; font-size: 16px; margin-bottom: 8px; }
                .protected-box small { color: #888; font-size: 12px; }
                .view-container .btn { width: 100%; padding: 16px; font-size: 15px; }
                .footer-text { color: #444; font-size: 12px; margin-top: 25px; }
                @media (max-width: 480px) { .view-container { padding: 35px 25px; } .view-container h1 { font-size: 26px; } }
            </style>
        </head>
        <body>
            <div class="view-container">
                <h1><img src="/logo.svg" class="view-logo" alt="ShieldHub"> ShieldHub</h1>
                <p class="subtitle">Script Protection System</p>
                <h2 style="margin: 20px 0; color: #fff;">${script.name}</h2>
                <div class="version-badge" style="display:inline-block; font-size: 14px; padding: 6px 16px;">${script.version}</div>
                <div class="protected-box">
                    <p>🔒 Protected Script</p>
                    <small>The real code is hidden. Use an executor to run it.</small>
                </div>
                <button class="btn" onclick="copyLoadstring('${prettyUrl}', this)">📋 COPY LOADSTRING</button>
                <p class="footer-text">Protected by ShieldHub</p>
            </div>
            <script>${TOAST_SCRIPT}</script>
        </body>
        </html>
        `);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== RAW ====================
app.get('/raw/:slug/:version/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(403).send("-- Access Denied --");
        
        const script = result.rows[0];
        if (script.slug !== req.params.slug || script.version !== req.params.version) {
            return res.status(403).send("-- Access Denied --");
        }
        
        const ua = req.headers['user-agent'] || '';
        const blocked = ['Mozilla', 'Chrome', 'Safari', 'Firefox', 'Edge', 'curl', 'wget', 'Postman'];
        for (const b of blocked) {
            if (ua.includes(b)) {
                return res.status(403).send("-- ShieldHub Protected -- Direct browser access denied. Use an executor. --");
            }
        }
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(script.public_content);
    } catch (e) {
        console.error(e);
        res.status(500).send("-- Server Error --");
    }
});

// ==================== ADMIN PANEL ====================
app.get('/admin', requireLogin, requireAdmin, async (req, res) => {
    try {
        const usersResult = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
        const users = usersResult.rows;
        
        const scriptsCountResult = await pool.query('SELECT owner, COUNT(*) as count FROM scripts GROUP BY owner');
        const scriptsCount = {};
        scriptsCountResult.rows.forEach(r => { scriptsCount[r.owner] = r.count; });
        
        let userCards = '';
        users.forEach(u => {
            const count = scriptsCount[u.username] || 0;
            const isUserAdmin = u.role === 'ADMIN';
            const avatarClass = isUserAdmin ? 'user-avatar user-avatar-admin' : 'user-avatar';
            const roleTag = isUserAdmin ? 'role-admin-tag' : 'role-user-tag';
            userCards += `
                <a href="/admin/user/${encodeURIComponent(u.username)}" class="user-card">
                    <div class="user-info">
                        <div class="${avatarClass}">${u.username.charAt(0)}</div>
                        <div class="user-details">
                            <span class="user-name">${u.username} <span class="role-tag ${roleTag}">${u.role}</span></span>
                            <span class="user-meta">Joined: ${new Date(u.created_at).toLocaleDateString()} • ${count} script${count !== 1 ? 's' : ''}</span>
                        </div>
                    </div>
                    <span class="btn btn-purple">View →</span>
                </a>
            `;
        });
        
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            ${getHtmlHead('Admin Panel - ShieldHub')}
            <style>${SHARED_STYLES}</style>
        </head>
        <body>
            <div class="header">
                <div class="header-brand">
                    <img src="/logo.svg" class="header-logo" alt="ShieldHub">
                    <span class="header-title">👑 Admin Panel</span>
                </div>
                <div class="header-right">
                    <a href="/" class="btn">← Dashboard</a>
                    <a href="/logout" class="btn btn-red">Logout</a>
                </div>
            </div>

            <h2 class="section-title">👥 All Users (${users.length})</h2>
            <p style="color: #666; font-size: 13px; margin-bottom: 15px;">Click on a user to view their scripts.</p>
            ${userCards || '<div class="card empty-state"><div class="empty-state-icon">👥</div><p>No users found.</p></div>'}
        </body>
        </html>
        `);
    } catch (e) {
        console.error('ADMIN ERROR:', e.message);
        res.status(500).send('Server error: ' + e.message);
    }
});

// ==================== ADMIN: VIEW USER SCRIPTS ====================
app.get('/admin/user/:username', requireLogin, requireAdmin, async (req, res) => {
    try {
        const targetUser = req.params.username;
        
        const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [targetUser]);
        if (userResult.rows.length === 0) return res.status(404).send('User not found');
        const targetUserData = userResult.rows[0];
        
        const scriptsResult = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [targetUser]);
        const userScripts = scriptsResult.rows;
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        
        let scriptCards = '';
        if (userScripts.length === 0) {
            scriptCards = `<div class="card empty-state"><div class="empty-state-icon">📭</div><p>This user has no scripts yet.</p></div>`;
        } else {
            userScripts.forEach(s => {
                const slug = s.slug || 'Script';
                const version = s.version || 'V1';
                const prettyUrl = `${baseUrl}/raw/${slug}/${version}/${s.token}`;
                scriptCards += `
                    <div class="script-card">
                        <h3>📄 ${s.name} <span class="version-badge">${version}</span></h3>
                        <div class="script-meta">Created: ${new Date(s.created_at).toLocaleDateString()}</div>
                        <div class="url-preview">${prettyUrl}</div>
                        <div class="actions">
                            <button class="btn" onclick="copyLoadstring('${prettyUrl}', this)">📋 Copy Loadstring</button>
                            <a href="/edit/${s.token}" class="btn btn-orange">✏️ Edit</a>
                            <a href="/view/${slug}/${version}/${s.token}" class="btn btn-blue" target="_blank">👁️ View</a>
                            <button class="btn btn-red" onclick="confirmDelete('${s.token}', '${s.name}')">🗑️ Delete</button>
                        </div>
                    </div>
                `;
            });
        }
        
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            ${getHtmlHead(targetUser + "'s Scripts - Admin")}
            <style>${SHARED_STYLES}</style>
        </head>
        <body>
            <div class="header">
                <div class="header-brand">
                    <img src="/logo.svg" class="header-logo" alt="ShieldHub">
                    <span class="header-title">👤 ${targetUser}</span>
                </div>
                <div class="header-right">
                    <a href="/admin" class="btn btn-purple">← All Users</a>
                    <a href="/" class="btn">Dashboard</a>
                </div>
            </div>

            <div class="card">
                <div class="user-info" style="padding: 10px 0;">
                    <div class="${targetUserData.role === 'ADMIN' ? 'user-avatar user-avatar-admin' : 'user-avatar'}">${targetUser.charAt(0)}</div>
                    <div class="user-details">
                        <span class="user-name">${targetUser} <span class="role-tag ${targetUserData.role === 'ADMIN' ? 'role-admin-tag' : 'role-user-tag'}">${targetUserData.role}</span></span>
                        <span class="user-meta">Joined: ${new Date(targetUserData.created_at).toLocaleDateString()}</span>
                    </div>
                </div>
            </div>

            <h2 class="section-title">📁 Scripts (${userScripts.length})</h2>
            ${scriptCards}
            <script>${TOAST_SCRIPT}</script>
        </body>
        </html>
        `);
    } catch (e) {
        console.error('ADMIN USER ERROR:', e.message);
        res.status(500).send('Server error: ' + e.message);
    }
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
        
        if (isAdmin && script.owner !== req.session.user.username) {
            return res.redirect('/admin/user/' + encodeURIComponent(script.owner));
        }
        res.redirect('/');
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`✅ ShieldHub v13.0 running on port ${PORT}`);
    console.log(`🎨 Logo served at /logo.svg`);
    console.log(`⭐ Favicon served at /favicon.svg`);
    console.log(`👑 Admin Panel at /admin`);
});
