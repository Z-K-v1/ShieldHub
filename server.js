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
    console.error('❌ DATABASE_URL is not set! Add it in Render Environment Variables.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==================== ENCRYPTION HELPERS ====================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex'), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ==================== ANTI-DUMP OBFUSCATION ====================
function obfuscateScript(code) {
    // Wrap with anti-dump protection + string encryption
    const encoded = Buffer.from(code).toString('base64');
    return `
-- ShieldHub Protected Script v2.0
-- Unauthorized copying is prohibited
local _S = (function()
    local _d = "${encoded}"
    local _b = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    local _o = {}
    local _i = 1
    while _i <= #_d do
        local _c1 = _b:find(_d:sub(_i, _i), 1, true) or 0
        local _c2 = _b:find(_d:sub(_i+1, _i+1), 1, true) or 0
        local _c3 = _b:find(_d:sub(_i+2, _i+2), 1, true) or 0
        local _c4 = _b:find(_d:sub(_i+3, _i+3), 1, true) or 0
        local _n = _c1 * 262144 + _c2 * 4096 + _c3 * 64 + _c4
        local _b1 = math.floor(_n / 65536) % 256
        local _b2 = math.floor(_n / 256) % 256
        local _b3 = _n % 256
        table.insert(_o, string.char(_b1))
        if _c3 ~= 64 then table.insert(_o, string.char(_b2)) end
        if _c4 ~= 64 then table.insert(_o, string.char(_b3)) end
        _i = _i + 4
    end
    return table.concat(_o)
end)()

-- Anti-dump check
local _hook = debug and debug.getinfo
if _hook and _hook(1, "S").what == "main" then
    -- Normal execution
else
    return
end

-- Execute
local _f = loadstring(_S)
if _f then _f() end
`;
}

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
                real_content TEXT NOT NULL,
                public_content TEXT NOT NULL,
                token VARCHAR(64) UNIQUE NOT NULL,
                owner VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS keys (
                id SERIAL PRIMARY KEY,
                script_token VARCHAR(64) NOT NULL,
                key_value VARCHAR(128) UNIQUE NOT NULL,
                hwid VARCHAR(128),
                used BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '1 day')
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

// ==================== LOGIN PAGE ====================
app.get('/login', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - Login</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .container { background: #111; padding: 40px; border-radius: 15px; border: 1px solid #333; width: 350px; text-align: center; }
            h1 { color: #00ff88; }
            input { width: 100%; padding: 12px; margin: 8px 0; background: #222; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; }
            .btn { background: #00ff88; color: black; padding: 12px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; width: 100%; font-size: 16px; margin-top: 10px; }
            .link { color: #00ff88; text-decoration: none; display: block; margin-top: 15px; font-size: 14px; }
            .msg { margin-top: 10px; font-size: 13px; }
            .error { color: #ff4444; }
            .success { color: #00ff88; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>ShieldHub</h1>
            <p style="color: #888;">Login to Dashboard</p>
            <form action="/login" method="POST">
                <input type="text" name="username" placeholder="Name" required>
                <input type="password" name="password" placeholder="Password" required>
                <button type="submit" class="btn">Login</button>
            </form>
            <p class="msg error">${req.query.error ? 'Invalid name or password!' : ''}</p>
            <p class="msg success">${req.query.registered ? 'Account created! Please login.' : ''}</p>
            <a href="/register" class="link">Create new account</a>
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
            body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .container { background: #111; padding: 40px; border-radius: 15px; border: 1px solid #333; width: 350px; text-align: center; }
            h1 { color: #00ff88; }
            input { width: 100%; padding: 12px; margin: 8px 0; background: #222; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; }
            .btn { background: #00ff88; color: black; padding: 12px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; width: 100%; font-size: 16px; margin-top: 10px; }
            .link { color: #00ff88; text-decoration: none; display: block; margin-top: 15px; font-size: 14px; }
            .msg { margin-top: 10px; font-size: 13px; }
            .error { color: #ff4444; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>ShieldHub</h1>
            <p style="color: #888;">Create Account</p>
            <form action="/register" method="POST">
                <input type="text" name="username" placeholder="Name" required>
                <input type="password" name="password" placeholder="Password" required>
                <input type="password" name="confirmPassword" placeholder="Confirm Password" required>
                <button type="submit" class="btn">Register</button>
            </form>
            <p class="msg error">${req.query.error || ''}</p>
            <a href="/login" class="link">Already have an account? Login here</a>
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
            <style>
                body { background: #0a0a0a; color: white; font-family: sans-serif; padding: 20px; }
                .header { display: flex; justify-content: space-between; align-items: center; background: #111; padding: 15px; border-radius: 10px; flex-wrap: wrap; gap: 10px; }
                .card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin: 10px 0; border: 1px solid #333; }
                .btn { background: #00ff88; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; font-size: 14px; }
                .btn-red { background: #ff4444; color: white; }
                .btn-orange { background: #ffaa00; color: black; }
                .btn-blue { background: #0088ff; color: white; }
                .btn-purple { background: #aa44ff; color: white; }
                input, textarea { width: 100%; padding: 10px; margin: 5px 0; background: #222; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; }
                .badge { background: #00ff88; color: black; padding: 5px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px; font-weight: bold; }
                .badge-admin { background: #ffaa00; color: black; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>ShieldHub</h1>
                <div>
                    <span>${req.session.user.username}</span>
                    ${isAdmin ? '<span class="badge badge-admin">ADMIN</span>' : '<span class="badge">USER</span>'}
                    <a href="/logout" class="btn btn-red" style="margin-left: 10px;">Logout</a>
                </div>
            </div>

            <h2>My Scripts</h2>
            <div class="card">
                <h3>Create New Script</h3>
                <form action="/create" method="POST">
                    <input type="text" name="name" placeholder="Script Name" required>
                    <textarea name="content" rows="5" placeholder="Paste your Lua script here..." required></textarea>
                    <button type="submit" class="btn">+ Create Script</button>
                </form>
            </div>
            <h3>Your Scripts</h3>
        `;
        
        if (myScripts.length === 0) {
            html += `<div class="card"><p style="color: #888;">No scripts yet. Create one above!</p></div>`;
        } else {
            myScripts.forEach(s => {
                html += `
                <div class="card">
                    <h3>📄 ${s.name}</h3>
                    <p style="color: #888; font-size: 12px;">Created: ${new Date(s.created_at).toLocaleDateString()}</p>
                    <div style="margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
                        <a href="/keys/${s.token}" class="btn btn-purple">🔑 Manage Keys</a>
                        <a href="/edit/${s.token}" class="btn btn-orange">✏️ Edit</a>
                        <a href="/view/${s.token}" class="btn btn-blue" target="_blank">👁️ View Page</a>
                        <button class="btn btn-red" onclick="confirmDelete('${s.token}', '${s.name}')">🗑️ Delete</button>
                    </div>
                </div>
                `;
            });
        }
        html += `
        <script>
            function confirmDelete(token, name) {
                if (confirm('⚠️ Are you sure you want to delete "' + name + '"?')) {
                    window.location.href = '/delete/' + token;
                }
            }
        </script>
        </body></html>
        `;
        res.send(html);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== CREATE SCRIPT ====================
app.post('/create', requireLogin, async (req, res) => {
    try {
        const { name, content } = req.body;
        const token = crypto.randomBytes(16).toString('hex');
        await pool.query(
            'INSERT INTO scripts (name, real_content, public_content, token, owner) VALUES ($1, $2, $3, $4, $5)',
            [name, content, obfuscateScript(content), token, req.session.user.username]
        );
        res.redirect('/');
    } catch (e) { console.error(e); res.status(500).send('Error creating script'); }
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
            <style>
                body { background: #0a0a0a; color: white; font-family: sans-serif; padding: 20px; }
                .header { display: flex; justify-content: space-between; align-items: center; background: #111; padding: 15px; border-radius: 10px; }
                .card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin: 10px 0; border: 1px solid #333; }
                .btn { background: #00ff88; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; }
                input, textarea { width: 100%; padding: 10px; margin: 5px 0; background: #222; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; font-family: monospace; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>Edit Script</h1>
                <a href="/" class="btn">← Back</a>
            </div>
            <div class="card">
                <form action="/edit/${script.token}" method="POST">
                    <label>Script Name:</label>
                    <input type="text" name="name" value="${script.name}" required>
                    <label>Script Content (Real Code):</label>
                    <textarea name="content" rows="20" required>${script.real_content}</textarea>
                    <button type="submit" class="btn">💾 Save Changes</button>
                </form>
            </div>
        </body>
        </html>
        `);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.post('/edit/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Script not found");
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");

        await pool.query(
            'UPDATE scripts SET name = $1, real_content = $2, public_content = $3 WHERE token = $4',
            [req.body.name, req.body.content, obfuscateScript(req.body.content), req.params.token]
        );
        res.redirect('/');
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== KEY MANAGEMENT ====================
app.get('/keys/:token', requireLogin, async (req, res) => {
    try {
        const scriptResult = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (scriptResult.rows.length === 0) return res.status(404).send("Script not found");
        const script = scriptResult.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");

        const keysResult = await pool.query('SELECT * FROM keys WHERE script_token = $1 ORDER BY created_at DESC', [req.params.token]);
        const keys = keysResult.rows;

        let keyRows = '';
        keys.forEach(k => {
            keyRows += `
            <tr style="border-bottom: 1px solid #333;">
                <td style="padding: 10px; font-family: monospace; font-size: 12px;">${k.key_value}</td>
                <td style="padding: 10px; font-size: 12px;">${k.hwid ? k.hwid.slice(0, 16) + '...' : '<span style="color: #ffaa00;">Not used</span>'}</td>
                <td style="padding: 10px; font-size: 12px;">${k.used ? '<span style="color: #ff4444;">Used</span>' : '<span style="color: #00ff88;">Available</span>'}</td>
                <td style="padding: 10px; font-size: 12px;">${new Date(k.expires_at).toLocaleString()}</td>
                <td style="padding: 10px;">
                    <button class="btn btn-red" style="padding: 5px 10px; font-size: 12px;" onclick="deleteKey(${k.id})">🗑️</button>
                </td>
            </tr>
            `;
        });

        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Manage Keys - ShieldHub</title>
            <style>
                body { background: #0a0a0a; color: white; font-family: sans-serif; padding: 20px; }
                .header { display: flex; justify-content: space-between; align-items: center; background: #111; padding: 15px; border-radius: 10px; margin-bottom: 20px; }
                .card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin: 10px 0; border: 1px solid #333; }
                .btn { background: #00ff88; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; }
                .btn-red { background: #ff4444; color: white; }
                .btn-purple { background: #aa44ff; color: white; }
                table { width: 100%; border-collapse: collapse; }
                th { background: #222; padding: 12px; text-align: left; font-size: 13px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🔑 Keys for: ${script.name}</h1>
                <a href="/" class="btn">← Back</a>
            </div>
            
            <div class="card">
                <h3>Generate New Key</h3>
                <p style="color: #888; font-size: 13px;">Create a HWID-locked key for your users. Each key works on ONE device only.</p>
                <form action="/keys/${script.token}/generate" method="POST">
                    <button type="submit" class="btn btn-purple">🔑 Generate New Key</button>
                </form>
            </div>

            <div class="card">
                <h3>Existing Keys (${keys.length})</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Key</th>
                            <th>HWID</th>
                            <th>Status</th>
                            <th>Expires</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${keyRows || '<tr><td colspan="5" style="padding: 20px; text-align: center; color: #888;">No keys generated yet.</td></tr>'}
                    </tbody>
                </table>
            </div>

            <script>
                function deleteKey(id) {
                    if (confirm('Delete this key?')) {
                        window.location.href = '/keys/delete/' + id;
                    }
                }
            </script>
        </body>
        </html>
        `);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.post('/keys/:token/generate', requireLogin, async (req, res) => {
    try {
        const scriptResult = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (scriptResult.rows.length === 0) return res.status(404).send("Script not found");
        const script = scriptResult.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");

        const newKey = 'SH-' + crypto.randomBytes(16).toString('hex').toUpperCase();
        await pool.query(
            'INSERT INTO keys (script_token, key_value) VALUES ($1, $2)',
            [req.params.token, newKey]
        );
        res.redirect('/keys/' + req.params.token);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

app.get('/keys/delete/:id', requireLogin, async (req, res) => {
    try {
        const keyResult = await pool.query('SELECT * FROM keys WHERE id = $1', [req.params.id]);
        if (keyResult.rows.length === 0) return res.redirect('/');
        const key = keyResult.rows[0];
        const scriptResult = await pool.query('SELECT * FROM scripts WHERE token = $1', [key.script_token]);
        const script = scriptResult.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");

        await pool.query('DELETE FROM keys WHERE id = $1', [req.params.id]);
        res.redirect('/keys/' + key.script_token);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== VIEW PAGE ====================
app.get('/view/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Script not found");
        const script = result.rows[0];
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const loaderUrl = `${baseUrl}/loader/${script.token}`;

        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>ShieldHub - ${script.name}</title>
            <style>
                body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
                .container { background: #111; padding: 40px; border-radius: 15px; text-align: center; border: 1px solid #333; width: 500px; }
                .protected-box { border: 1px solid #ff4444; padding: 20px; border-radius: 10px; margin: 20px 0; color: #ff4444; background: #1a0a0a; }
                .btn { background: #00ff88; color: black; padding: 15px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; width: 100%; font-size: 16px; margin: 5px 0; }
                .btn-purple { background: #aa44ff; color: white; }
                .key-input { width: 100%; padding: 12px; background: #222; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; font-family: monospace; text-align: center; font-size: 14px; margin: 10px 0; }
                .code-box { background: #0a0a0a; border: 1px solid #333; padding: 15px; border-radius: 5px; font-family: monospace; font-size: 12px; color: #00ff88; word-break: break-all; margin: 10px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1 style="color: #00ff88;">ShieldHub</h1>
                <p style="color: #888;">HWID-Locked Script Protection</p>
                <h2>${script.name}</h2>
                <div class="protected-box">
                    <p>🔒 Protected by ShieldHub v2.0</p>
                    <small>HWID-Locked • Anti-Copy • Encrypted</small>
                </div>
                
                <h3>Step 1: Enter Your Key</h3>
                <input type="text" id="userKey" class="key-input" placeholder="SH-XXXXXXXXXXXXXXXX">
                
                <h3>Step 2: Copy Loader</h3>
                <div class="code-box" id="loaderCode">loadstring(game:HttpGet("${loaderUrl}"))()</div>
                <button class="btn" onclick="copyLoader()">📋 Copy Loader</button>
                
                <p style="color: #555; font-size: 12px; margin-top: 20px;">The loader will ask for your key and bind it to your HWID.</p>
            </div>
            <script>
                function copyLoader() {
                    const code = document.getElementById('loaderCode').innerText;
                    navigator.clipboard.writeText(code);
                    alert('✅ Loader copied!\\n\\nPaste this in your executor.');
                }
            </script>
        </body>
        </html>
        `);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== LOADER (Lua) ====================
app.get('/loader/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("-- Script not found --");
        const script = result.rows[0];
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

        // This loader will run in executor, ask for key, validate with server
        const loader = `
-- ShieldHub Loader v2.0
-- HWID-Locked Script Protection

local function getHWID()
    local hwid = nil
    pcall(function()
        if gethwid then hwid = gethwid()
        elseif game.GetService then
            hwid = game:GetService("RbxAnalyticsService"):GetClientId()
        end
    end)
    if not hwid then
        hwid = tostring(math.random(100000, 999999)) .. tostring(os.time())
    end
    return hwid
end

local HWID = getHWID()
local BASE_URL = "${baseUrl}"
local TOKEN = "${script.token}"

-- Ask for key
local key = nil
if writefile and readfile then
    pcall(function() key = readfile("shieldhub_key.txt") end)
end

if not key then
    if not getgenv().ShieldHubKey then
        print("[ShieldHub] Please enter your key:")
    end
end

-- For simplicity, use getgenv().ShieldHubKey
key = getgenv().ShieldHubKey or key

if not key then
    warn("[ShieldHub] ❌ No key provided!")
    warn("[ShieldHub] Set it with: getgenv().ShieldHubKey = 'YOUR_KEY'")
    return
end

-- Validate key with server
local http = game:GetService("HttpService")
local validateUrl = BASE_URL .. "/validate/" .. TOKEN .. "?key=" .. key .. "&hwid=" .. HWID

local success, response = pcall(function()
    return http:GetAsync(validateUrl)
end)

if not success then
    warn("[ShieldHub] ❌ Validation failed: " .. tostring(response))
    return
end

local data = http:JSONDecode(response)

if not data.valid then
    warn("[ShieldHub] ❌ " .. (data.error or "Invalid key"))
    return
end

-- Execute the obfuscated payload
local payload = data.payload
if payload then
    local func = loadstring(payload)
    if func then
        func()
    else
        warn("[ShieldHub] ❌ Failed to load payload")
    end
end
`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(loader);
    } catch (e) { console.error(e); res.status(500).send("-- Server Error --"); }
});

// ==================== VALIDATE KEY (Server-Side) ====================
app.get('/validate/:token', async (req, res) => {
    try {
        const { key, hwid } = req.query;
        if (!key || !hwid) return res.json({ valid: false, error: "Missing key or HWID" });

        const scriptResult = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (scriptResult.rows.length === 0) return res.json({ valid: false, error: "Script not found" });
        const script = scriptResult.rows[0];

        const keyResult = await pool.query('SELECT * FROM keys WHERE key_value = $1 AND script_token = $2', [key, req.params.token]);
        if (keyResult.rows.length === 0) return res.json({ valid: false, error: "Invalid key" });
        const keyData = keyResult.rows[0];

        // Check expiry
        if (new Date(keyData.expires_at) < new Date()) {
            return res.json({ valid: false, error: "Key expired" });
        }

        // Check HWID lock
        if (keyData.hwid && keyData.hwid !== hwid) {
            return res.json({ valid: false, error: "Key locked to different device" });
        }

        // Bind HWID on first use
        if (!keyData.hwid) {
            await pool.query('UPDATE keys SET hwid = $1, used = TRUE WHERE id = $2', [hwid, keyData.id]);
        }

        // Return the obfuscated payload
        res.json({
            valid: true,
            payload: script.public_content
        });
    } catch (e) {
        console.error(e);
        res.json({ valid: false, error: "Server error" });
    }
});

// ==================== RAW (Disabled - Only obfuscated) ====================
app.get('/raw/:token', async (req, res) => {
    res.status(403).send("-- Access Denied -- Direct access is disabled. Use the loader. --");
});

// ==================== DELETE ====================
app.get('/delete/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.redirect('/');
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");

        await pool.query('DELETE FROM keys WHERE script_token = $1', [req.params.token]);
        await pool.query('DELETE FROM scripts WHERE token = $1', [req.params.token]);
        res.redirect('/');
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`✅ ShieldHub v2.0 running on port ${PORT}`);
    console.log(`🔒 HWID-Locked protection enabled.`);
});
