const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    secret: 'shieldhub-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// ==================== DATA STORAGE ====================
const DB_FILE = path.join(__dirname, 'data.json');

function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ scripts: [] }));
    }
    try { return JSON.parse(fs.readFileSync(DB_FILE)); }
    catch (e) { return { scripts: [] }; }
}
function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function requireLogin(req, res, next) {
    if (req.session.user) next();
    else res.redirect('/login');
}

// ==================== OBFUSCATION ====================
function obfuscateScript(code) {
    const base64 = Buffer.from(code).toString('base64');
    const key = crypto.randomBytes(16).toString('hex');
    const chunks = [];
    for (let i = 0; i < base64.length; i += 50) {
        chunks.push(base64.substring(i, i + 50));
    }
    return `
-- ShieldHub Protected Script
-- This script is obfuscated. Do not attempt to decode.
local _k = "${key}"
local _d = table.concat({${chunks.map(c => `"${c}"`).join(',')}})
local _b = game:GetService("HttpService"):Base64Decode(_d)
loadstring(_b)()
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
            .info { color: #888; font-size: 12px; margin-top: 15px; }
            .error { color: #ff4444; font-size: 13px; margin-top: 10px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>ShieldHub</h1>
            <p style="color: #888;">Enter your name to continue</p>
            <form action="/login" method="POST">
                <input type="text" name="username" placeholder="Enter your name" required>
                <button type="submit" class="btn">Login</button>
            </form>
            <p class="error">${req.query.error ? 'Name must be at least 2 characters.' : ''}</p>
            <p class="info">No password needed. Just your name.</p>
        </div>
    </body>
    </html>
    `);
});

app.post('/login', (req, res) => {
    const { username } = req.body;
    
    if (!username || username.length < 2) {
        return res.redirect('/login?error=1');
    }
    
    // Z-K is the only ADMIN
    if (username === 'Z-K') {
        req.session.user = { username: 'Z-K', role: 'ADMIN' };
    } else {
        req.session.user = { username: username, role: 'USER' };
    }
    
    res.redirect('/');
});

// ==================== LOGOUT ====================
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ==================== DASHBOARD ====================
app.get('/', requireLogin, (req, res) => {
    const db = readDB();
    const myScripts = db.scripts.filter(s => s.owner === req.session.user.username);
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const isAdmin = req.session.user.username === 'Z-K';
    
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
        </style>
    </head>
    <body>
        <div class="header">
            <h1>ShieldHub</h1>
            <div>
                <span>${req.session.user.username}</span>
                ${isAdmin ? '<span class="badge">ADMIN</span>' : ''}
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
                <p style="color: #888; font-size: 12px;">Created: ${new Date(s.createdAt).toLocaleDateString()}</p>
                <div style="margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
                    <button class="btn" onclick="copyRaw('${baseUrl}/raw/${s.token}')">📋 Copy Raw</button>
                    <a href="/edit/${s.token}" class="btn btn-orange">✏️ Edit</a>
                    <a href="/view/${s.token}" class="btn btn-blue" target="_blank">👁️ View</a>
                    <button class="btn btn-red" onclick="confirmDelete('${s.token}', '${s.name}')">🗑️ Delete</button>
                </div>
            </div>
            `;
        });
    }
    html += `
    <script>
        function copyRaw(url) {
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
});

// ==================== CREATE ====================
app.post('/create', requireLogin, (req, res) => {
    const { name, content } = req.body;
    const db = readDB();
    const token = crypto.randomBytes(16).toString('hex');
    
    db.scripts.push({
        name,
        realContent: content,
        publicContent: obfuscateScript(content),
        token,
        owner: req.session.user.username,
        createdAt: new Date()
    });
    writeDB(db);
    res.redirect('/');
});

// ==================== EDIT ====================
app.get('/edit/:token', requireLogin, (req, res) => {
    const db = readDB();
    const script = db.scripts.find(s => s.token === req.params.token);
    if (!script) return res.status(404).send("Script not found");
    
    const isAdmin = req.session.user.username === 'Z-K';
    if (script.owner !== req.session.user.username && !isAdmin) {
        return res.status(403).send("Access Denied");
    }

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
            <a href="/" class="btn">← Back to Dashboard</a>
        </div>
        <div class="card">
            <form action="/edit/${script.token}" method="POST">
                <label>Script Name:</label>
                <input type="text" name="name" value="${script.name}" required>
                <label>Script Content (Real Code):</label>
                <textarea name="content" rows="20" required>${script.realContent}</textarea>
                <button type="submit" class="btn">💾 Save Changes</button>
            </form>
        </div>
    </body>
    </html>
    `);
});

app.post('/edit/:token', requireLogin, (req, res) => {
    const db = readDB();
    const script = db.scripts.find(s => s.token === req.params.token);
    if (!script) return res.status(404).send("Script not found");
    
    const isAdmin = req.session.user.username === 'Z-K';
    if (script.owner !== req.session.user.username && !isAdmin) {
        return res.status(403).send("Access Denied");
    }

    script.name = req.body.name;
    script.realContent = req.body.content;
    script.publicContent = obfuscateScript(req.body.content);
    writeDB(db);
    res.redirect('/');
});

// ==================== VIEW ====================
app.get('/view/:token', (req, res) => {
    const db = readDB();
    const script = db.scripts.find(s => s.token === req.params.token);
    if (!script) return res.status(404).send("Script not found");
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const loadstring = `loadstring(game:HttpGet("${baseUrl}/raw/${script.token}"))()`;
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - ${script.name}</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .container { background: #111; padding: 40px; border-radius: 15px; text-align: center; border: 1px solid #333; width: 400px; }
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
                alert('Loadstring copied!');
            }
        </script>
    </body>
    </html>
    `);
});

// ==================== RAW (OBFUSCATED ONLY) ====================
app.get('/raw/:token', (req, res) => {
    const db = readDB();
    const script = db.scripts.find(s => s.token === req.params.token);
    if (!script) return res.status(403).send("-- Access Denied --");
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(script.publicContent);
});

// ==================== DELETE ====================
app.get('/delete/:token', requireLogin, (req, res) => {
    const db = readDB();
    const script = db.scripts.find(s => s.token === req.params.token);
    if (!script) return res.redirect('/');
    
    const isAdmin = req.session.user.username === 'Z-K';
    if (script.owner !== req.session.user.username && !isAdmin) {
        return res.status(403).send("Access Denied");
    }
    
    db.scripts = db.scripts.filter(s => s.token !== req.params.token);
    writeDB(db);
    res.redirect('/');
});

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`✅ ShieldHub running on port ${PORT}`);
    console.log(`👑 Admin: Z-K`);
    console.log(`🔒 All scripts are obfuscated.`);
});
