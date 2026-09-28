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

// ==================== OBFUSCATION (XOR ENCRYPTION) ====================
function obfuscateScript(code) {
    const bytes = Buffer.from(code, 'utf8');
    const key = crypto.randomBytes(16);
    const encrypted = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        encrypted[i] = bytes[i] ^ key[i % key.length];
    }
    const keyArray = Array.from(key).join(',');
    const encArray = Array.from(encrypted).join(',');
    return `
-- ShieldHub Protected v3.0
local _k={${keyArray}}
local _e={${encArray}}
local _d={}
for _i=1,#_e do
    _d[_i]=string.char(bit32.bxor(_e[_i],_k[((_i-1)%#_k)+1]))
end
local _c=table.concat(_d)
local _f=loadstring(_c)
if _f then _f() end
`;
}

// ==================== LOGIN ====================
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
                        <button class="btn" onclick="copyLoadstring('${baseUrl}/raw/${s.token}')">📋 Copy Loadstring</button>
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
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
});

// ==================== CREATE ====================
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

// ==================== VIEW ====================
app.get('/view/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Script not found");
        const script = result.rows[0];
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const loadstring = `loadstring(game:HttpGet("${baseUrl}/raw/${script.token}"))()`;
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>ShieldHub - ${script.name}</title>
            <style>
                body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { background: #111; padding: 40px; border-radius: 15px; text-align: center; border: 1px solid #333; width: 450px; }
                .protected-box { border: 1px solid #ff4444; padding: 20px; border-radius: 10px; margin: 20px 0; color: #ff4444; }
                .btn { background: #00ff88; color: black; padding: 15px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; width: 100%; font-size: 16px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1 style="color: #00ff88;">ShieldHub</h1>
                <p style="color: #888;">Script Protection System</p>
                <h2>${script.name}</h2>
                <div class="protected-box">
                    <p>🔒 Protected Script</p>
                    <small>The real code is hidden. Use an executor to run it.</small>
                </div>
                <button class="btn" onclick="copyLoadstring()">📋 COPY LOADSTRING</button>
                <p style="color: #555; font-size: 12px; margin-top: 20px;">Protected by ShieldHub</p>
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

// ==================== RAW (ENCRYPTED + BLOCKED) ====================
app.get('/raw/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(403).send("-- Access Denied --");
        
        const ua = req.headers['user-agent'] || '';
        const blocked = ['Mozilla', 'Chrome', 'Safari', 'Firefox', 'Edge', 'curl', 'wget', 'Postman'];
        for (const b of blocked) {
            if (ua.includes(b)) {
                return res.status(403).send("-- ShieldHub Protected -- Direct browser access denied. Use an executor. --");
            }
        }
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(result.rows[0].public_content);
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
    console.log(`✅ ShieldHub v3.0 running on port ${PORT}`);
    console.log(`🔒 XOR-encrypted scripts + browser blocking enabled.`);
});
