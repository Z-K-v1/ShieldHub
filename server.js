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

// ==================== DATABASE INIT (WITH AUTO-MIGRATION) ====================
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

        // 🔧 AUTO-MIGRATION: Add missing columns if they don't exist
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS slug VARCHAR(100) DEFAULT 'Script';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS version VARCHAR(50) DEFAULT 'V1';`);
        await pool.query(`UPDATE scripts SET slug = LOWER(REPLACE(name, ' ', '_')) WHERE slug = 'Script' OR slug IS NULL;`);
        await pool.query(`UPDATE scripts SET version = 'V1' WHERE version IS NULL;`);
        console.log('✅ Tables created/verified (with auto-migration)');

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

// ==================== OBFUSCATION ====================
function obfuscateScript(code) {
    const encoded = Buffer.from(code, 'utf8').toString('base64');
    return `
-- ShieldHub Protected v8.0
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

// ==================== SHARED STYLES ====================
const SHARED_STYLES = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
        background: #0a0a0a; 
        color: #e0e0e0; 
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
        padding: 20px;
        min-height: 100vh;
        background: radial-gradient(circle at top left, #0f1f15 0%, #0a0a0a 40%);
    }
    .header { 
        display: flex; 
        justify-content: space-between; 
        align-items: center; 
        background: rgba(17,17,17,0.8); 
        backdrop-filter: blur(10px);
        padding: 20px 25px; 
        border-radius: 16px; 
        border: 1px solid #222;
        flex-wrap: wrap; 
        gap: 15px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .header h1 {
        font-size: 24px;
        color: #00ff88;
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .header h1::before {
        content: '🛡️';
        font-size: 28px;
    }
    .header-right {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }
    .badge { 
        background: #00ff88; 
        color: #000; 
        padding: 6px 14px; 
        border-radius: 20px; 
        font-size: 12px; 
        font-weight: 700;
        letter-spacing: 0.5px;
    }
    .badge-admin { 
        background: linear-gradient(135deg, #ffaa00, #ff6600); 
        color: #000;
    }
    .btn { 
        background: #00ff88; 
        color: #000; 
        padding: 11px 22px; 
        border: none; 
        border-radius: 10px; 
        cursor: pointer; 
        font-weight: 700; 
        text-decoration: none; 
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 14px;
        transition: all 0.2s ease;
        font-family: inherit;
    }
    .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(0, 255, 136, 0.4);
    }
    .btn-red { 
        background: linear-gradient(135deg, #ff4444, #cc0000); 
        color: #fff; 
    }
    .btn-red:hover { box-shadow: 0 6px 20px rgba(255, 68, 68, 0.4); }
    .btn-orange { 
        background: linear-gradient(135deg, #ffaa00, #ff8800); 
        color: #000; 
    }
    .btn-orange:hover { box-shadow: 0 6px 20px rgba(255, 170, 0, 0.4); }
    .btn-blue { 
        background: linear-gradient(135deg, #0088ff, #0066cc); 
        color: #fff; 
    }
    .btn-blue:hover { box-shadow: 0 6px 20px rgba(0, 136, 255, 0.4); }
    .card { 
        background: linear-gradient(135deg, #1a1a1a 0%, #151515 100%);
        padding: 25px; 
        border-radius: 16px; 
        margin: 20px 0; 
        border: 1px solid #222;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .form-group { margin-bottom: 20px; }
    .form-label {
        display: block;
        margin-bottom: 8px;
        font-size: 13px;
        font-weight: 600;
        color: #aaa;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
        margin-bottom: 20px;
    }
    input, textarea, select { 
        width: 100%; 
        padding: 14px 16px; 
        background: #0a0a0a; 
        border: 2px solid #2a2a2a; 
        color: #fff; 
        border-radius: 10px; 
        font-size: 14px;
        font-family: inherit;
        transition: all 0.2s ease;
        outline: none;
    }
    input:focus, textarea:focus, select:focus {
        border-color: #00ff88;
        box-shadow: 0 0 0 4px rgba(0, 255, 136, 0.1);
    }
    textarea {
        font-family: 'Consolas', 'Monaco', monospace;
        resize: vertical;
        min-height: 100px;
    }
    select {
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2300ff88' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'/%3e%3c/svg%3e");
        background-repeat: no-repeat;
        background-position: right 15px center;
        background-size: 20px;
        padding-right: 45px;
    }
    .section-title {
        font-size: 20px;
        font-weight: 700;
        color: #fff;
        margin: 30px 0 15px 0;
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .version-badge { 
        background: linear-gradient(135deg, #aa44ff, #8800cc); 
        color: #fff; 
        padding: 4px 12px; 
        border-radius: 8px; 
        font-size: 12px; 
        font-weight: 700;
        margin-left: 8px;
    }
    .url-preview { 
        background: #0a0a0a; 
        border: 1px solid #2a2a2a; 
        padding: 12px 16px; 
        border-radius: 10px; 
        font-family: 'Consolas', 'Monaco', monospace; 
        font-size: 12px; 
        color: #00ff88; 
        word-break: break-all; 
        margin: 10px 0;
    }
    .script-card {
        background: linear-gradient(135deg, #1a1a1a 0%, #151515 100%);
        padding: 25px; 
        border-radius: 16px; 
        margin: 15px 0; 
        border: 1px solid #222;
        transition: all 0.2s ease;
    }
    .script-card:hover {
        border-color: #00ff88;
        transform: translateY(-2px);
    }
    .script-card h3 {
        font-size: 18px;
        color: #fff;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
    }
    .script-meta { color: #666; font-size: 12px; margin-bottom: 15px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 15px; }
    .empty-state { text-align: center; padding: 40px; color: #666; }
    .empty-state-icon { font-size: 48px; margin-bottom: 15px; opacity: 0.5; }
    @media (max-width: 600px) {
        .form-row { grid-template-columns: 1fr; }
        body { padding: 10px; }
    }
`;

// ==================== LOGIN ====================
app.get('/login', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - Login</title>
        <style>
            ${SHARED_STYLES}
            body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
            .login-container { 
                background: linear-gradient(135deg, #1a1a1a 0%, #111 100%);
                padding: 50px 40px; 
                border-radius: 20px; 
                border: 1px solid #222; 
                width: 400px; 
                max-width: 100%;
                text-align: center;
                box-shadow: 0 20px 60px rgba(0,0,0,0.5);
            }
            .login-container h1 { 
                color: #00ff88; 
                font-size: 32px;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
            }
            .login-container h1::before { content: '🛡️'; font-size: 36px; }
            .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
            .login-container input { margin-bottom: 15px; text-align: center; }
            .login-container .btn { width: 100%; margin-top: 10px; }
            .msg { margin-top: 15px; font-size: 13px; }
            .error { color: #ff4444; }
            .success { color: #00ff88; }
            .link { color: #00ff88; text-decoration: none; display: block; margin-top: 20px; font-size: 14px; }
            .link:hover { text-decoration: underline; }
        </style>
    </head>
    <body>
        <div class="login-container">
            <h1>ShieldHub</h1>
            <p class="subtitle">Login to your dashboard</p>
            <form action="/login" method="POST">
                <input type="text" name="username" placeholder="Username" required>
                <input type="password" name="password" placeholder="Password" required>
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
    <html>
    <head>
        <title>ShieldHub - Register</title>
        <style>
            ${SHARED_STYLES}
            body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
            .login-container { 
                background: linear-gradient(135deg, #1a1a1a 0%, #111 100%);
                padding: 50px 40px; 
                border-radius: 20px; 
                border: 1px solid #222; 
                width: 400px; 
                max-width: 100%;
                text-align: center;
                box-shadow: 0 20px 60px rgba(0,0,0,0.5);
            }
            .login-container h1 { 
                color: #00ff88; 
                font-size: 32px;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
            }
            .login-container h1::before { content: '🛡️'; font-size: 36px; }
            .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
            .login-container input { margin-bottom: 15px; text-align: center; }
            .login-container .btn { width: 100%; margin-top: 10px; }
            .msg { margin-top: 15px; font-size: 13px; }
            .error { color: #ff4444; }
            .link { color: #00ff88; text-decoration: none; display: block; margin-top: 20px; font-size: 14px; }
            .link:hover { text-decoration: underline; }
        </style>
    </head>
    <body>
        <div class="login-container">
            <h1>ShieldHub</h1>
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
        <html>
        <head>
            <title>ShieldHub - Dashboard</title>
            <style>${SHARED_STYLES}</style>
        </head>
        <body>
            <div class="header">
                <h1>ShieldHub</h1>
                <div class="header-right">
                    <span>${req.session.user.username}</span>
                    ${isAdmin ? '<span class="badge badge-admin">ADMIN</span>' : '<span class="badge">USER</span>'}
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
                            <select name="version" required>
                                ${versionDropdown('V1')}
                            </select>
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
            html += `
            <div class="card empty-state">
                <div class="empty-state-icon">📭</div>
                <p>No scripts yet. Create your first script above!</p>
            </div>`;
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
                        <button class="btn" onclick="copyLoadstring('${prettyUrl}')">📋 Copy Loadstring</button>
                        <a href="/edit/${s.token}" class="btn btn-orange">✏️ Edit</a>
                        <a href="/view/${slug}/${version}/${s.token}" class="btn btn-blue" target="_blank">👁️ View</a>
                        <button class="btn btn-red" onclick="confirmDelete('${s.token}', '${s.name}')">🗑️ Delete</button>
                    </div>
                </div>
                `;
            });
        }
        html += `
        <script>
            function copyLoadstring(url) {
                const loadstring = \`loadstring(game:HttpGet("\${url}"))()\`;
                navigator.clipboard.writeText(loadstring);
                alert('✅ Loadstring copied!\\n\\n' + loadstring);
            }
            function confirmDelete(token, name) {
                if (confirm('⚠️ Are you sure you want to delete "' + name + '"?')) {
                    window.location.href = '/delete/' + token;
                }
            }
        </script>
        </body></html>
        `;
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
        <html>
        <head>
            <title>Edit Script - ShieldHub</title>
            <style>${SHARED_STYLES}</style>
        </head>
        <body>
            <div class="header">
                <h1>Edit Script</h1>
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
                            <select name="version" required>
                                ${versionDropdown(script.version)}
                            </select>
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
        <html>
        <head>
            <title>ShieldHub - ${script.name}</title>
            <style>
                ${SHARED_STYLES}
                body { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
                .view-container {
                    background: linear-gradient(135deg, #1a1a1a 0%, #111 100%);
                    padding: 50px 40px;
                    border-radius: 20px;
                    border: 1px solid #222;
                    width: 500px;
                    max-width: 100%;
                    text-align: center;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                }
                .view-container h1 {
                    color: #00ff88;
                    font-size: 32px;
                    margin-bottom: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 10px;
                }
                .view-container h1::before { content: '🛡️'; font-size: 36px; }
                .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
                .protected-box {
                    border: 2px solid #ff4444;
                    padding: 25px;
                    border-radius: 12px;
                    margin: 25px 0;
                    background: rgba(255, 68, 68, 0.05);
                }
                .protected-box p {
                    color: #ff4444;
                    font-weight: 700;
                    font-size: 16px;
                    margin-bottom: 8px;
                }
                .protected-box small { color: #888; font-size: 12px; }
                .view-container .btn { width: 100%; padding: 16px; font-size: 15px; }
                .footer-text { color: #444; font-size: 12px; margin-top: 25px; }
            </style>
        </head>
        <body>
            <div class="view-container">
                <h1>ShieldHub</h1>
                <p class="subtitle">Script Protection System</p>
                <h2 style="margin: 20px 0; color: #fff;">${script.name}</h2>
                <div class="version-badge" style="display:inline-block; font-size: 14px; padding: 6px 16px;">${script.version}</div>
                <div class="protected-box">
                    <p>🔒 Protected Script</p>
                    <small>The real code is hidden. Use an executor to run it.</small>
                </div>
                <button class="btn" onclick="copyLoadstring()">📋 COPY LOADSTRING</button>
                <p class="footer-text">Protected by ShieldHub</p>
            </div>
            <script>
                function copyLoadstring() {
                    navigator.clipboard.writeText(\`${loadstring}\`);
                    alert('✅ Loadstring copied!');
                }
            </script>
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

// ==================== DELETE ====================
app.get('/delete/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.redirect('/');
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");

        await pool.query('DELETE FROM scripts WHERE token = $1', [req.params.token]);
        res.redirect('/');
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`✅ ShieldHub v8.0 running on port ${PORT}`);
    console.log(`🔧 Auto-migration enabled`);
    console.log(`🎨 Beautiful UI enabled`);
    console.log(`📋 Version dropdown: V1 to V1000`);
});
