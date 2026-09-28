const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MONGODB CONNECTION ====================
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGO_URI is not set! Add it in Render Environment Variables.');
    process.exit(1);
}

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB');
        // Auto-create Admin account if it doesn't exist
        const adminPass = process.env.ADMIN_PASSWORD;
        if (adminPass) {
            const existingAdmin = await User.findOne({ username: 'Z-K' });
            if (!existingAdmin) {
                await User.create({ username: 'Z-K', password: adminPass, role: 'ADMIN' });
                console.log('👑 Admin account "Z-K" created automatically.');
            }
        }
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'USER' },
    createdAt: { type: Date, default: Date.now }
});

const scriptSchema = new mongoose.Schema({
    name: { type: String, required: true },
    realContent: { type: String, required: true },
    publicContent: { type: String, required: true },
    token: { type: String, required: true, unique: true },
    owner: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Script = mongoose.model('Script', scriptSchema);

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'shieldhub-secret-key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

function requireLogin(req, res, next) {
    if (req.session.user) next();
    else res.redirect('/login');
}

// ==================== OBFUSCATION ====================
function obfuscateScript(code) {
    return `loadstring([==[${code}]==])()`;
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
        const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
        if (!user || user.password !== password) return res.redirect('/login?error=1');
        req.session.user = { username: user.username, role: user.role };
        res.redirect('/');
    } catch (e) {
        console.error(e);
        res.redirect('/login?error=1');
    }
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
        
        const existing = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
        if (existing) return res.redirect('/register?error=Name already taken!');
        
        const role = username === 'Z-K' ? 'ADMIN' : 'USER';
        await User.create({ username, password, role });
        res.redirect('/login?registered=1');
    } catch (e) {
        console.error(e);
        res.redirect('/register?error=Server error');
    }
});

// ==================== LOGOUT ====================
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ==================== DASHBOARD ====================
app.get('/', requireLogin, async (req, res) => {
    try {
        const myScripts = await Script.find({ owner: req.session.user.username });
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
    } catch (e) {
        console.error(e);
        res.status(500).send('Server error');
    }
});

// ==================== CREATE ====================
app.post('/create', requireLogin, async (req, res) => {
    try {
        const { name, content } = req.body;
        const token = crypto.randomBytes(16).toString('hex');
        
        await Script.create({
            name,
            realContent: content,
            publicContent: obfuscateScript(content),
            token,
            owner: req.session.user.username
        });
        res.redirect('/');
    } catch (e) {
        console.error(e);
        res.status(500).send('Error creating script');
    }
});

// ==================== EDIT ====================
app.get('/edit/:token', requireLogin, async (req, res) => {
    try {
        const script = await Script.findOne({ token: req.params.token });
        if (!script) return res.status(404).send("Script not found");
        
        const isAdmin = req.session.user.role === 'ADMIN';
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
    } catch (e) {
        console.error(e);
        res.status(500).send('Server error');
    }
});

app.post('/edit/:token', requireLogin, async (req, res) => {
    try {
        const script = await Script.findOne({ token: req.params.token });
        if (!script) return res.status(404).send("Script not found");
        
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) {
            return res.status(403).send("Access Denied");
        }

        script.name = req.body.name;
        script.realContent = req.body.content;
        script.publicContent = obfuscateScript(req.body.content);
        await script.save();
        res.redirect('/');
    } catch (e) {
        console.error(e);
        res.status(500).send('Server error');
    }
});

// ==================== VIEW ====================
app.get('/view/:token', async (req, res) => {
    try {
        const script = await Script.findOne({ token: req.params.token });
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
    } catch (e) {
        console.error(e);
        res.status(500).send('Server error');
    }
});

// ==================== RAW ====================
app.get('/raw/:token', async (req, res) => {
    try {
        const script = await Script.findOne({ token: req.params.token });
        if (!script) return res.status(403).send("-- Access Denied --");
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(script.publicContent);
    } catch (e) {
        console.error(e);
        res.status(500).send("-- Server Error --");
    }
});

// ==================== DELETE ====================
app.get('/delete/:token', requireLogin, async (req, res) => {
    try {
        const script = await Script.findOne({ token: req.params.token });
        if (!script) return res.redirect('/');
        
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) {
            return res.status(403).send("Access Denied");
        }
        
        await Script.deleteOne({ token: req.params.token });
        res.redirect('/');
    } catch (e) {
        console.error(e);
        res.status(500).send('Server error');
    }
});

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`✅ ShieldHub running on port ${PORT}`);
    console.log(`🔒 Scripts are wrapped in loadstring — works in all executors.`);
});
