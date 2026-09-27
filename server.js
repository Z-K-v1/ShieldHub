const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MONGODB CONNECTION ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/shieldhub';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// ==================== SCHEMAS ====================
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'USER' },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const scriptSchema = new mongoose.Schema({
    name: { type: String, required: true },
    content: { type: String, required: true },
    token: { type: String, required: true, unique: true },
    owner: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Script = mongoose.model('Script', scriptSchema);

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'shieldhub-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

function requireLogin(req, res, next) {
    if (req.session.user) next();
    else res.redirect('/login');
}

// ==================== DEFAULT OWNER ====================
async function ensureDefaultOwner() {
    const ownerExists = await User.findOne({ role: 'OWNER' });
    if (!ownerExists) {
        await User.create({
            username: 'Zyrox',
            password: bcrypt.hashSync('admin123', 10),
            role: 'OWNER'
        });
        console.log('👤 Default owner created: Zyrox / admin123');
    }
}
ensureDefaultOwner();

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
            .error { color: #ff4444; margin-top: 10px; }
            .success { color: #00ff88; margin-top: 10px; }
            .link { color: #00ff88; text-decoration: none; display: block; margin-top: 15px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>ShieldHub</h1>
            <p style="color: #888;">Login to Dashboard</p>
            <form action="/login" method="POST">
                <input type="text" name="username" placeholder="Username" required>
                <input type="password" name="password" placeholder="Password" required>
                <button type="submit" class="btn">Login</button>
            </form>
            <p class="error">${req.query.error ? 'Invalid username or password!' : ''}</p>
            ${req.query.registered ? '<p class="success">Account created! Please login.</p>' : ''}
            <a href="/register" class="link">Create new account</a>
        </div>
    </body>
    </html>
    `);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.user = { username: user.username, role: user.role };
        res.redirect('/');
    } else {
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
            .error { color: #ff4444; margin-top: 10px; }
            .link { color: #00ff88; text-decoration: none; display: block; margin-top: 15px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>ShieldHub</h1>
            <p style="color: #888;">Create New Account</p>
            <form action="/register" method="POST">
                <input type="text" name="username" placeholder="Username" required>
                <input type="password" name="password" placeholder="Password" required>
                <input type="password" name="confirmPassword" placeholder="Confirm Password" required>
                <button type="submit" class="btn">Register</button>
            </form>
            <p class="error">${req.query.error || ''}</p>
            <a href="/login" class="link">Already have an account? Login here</a>
        </div>
    </body>
    </html>
    `);
});

app.post('/register', async (req, res) => {
    const { username, password, confirmPassword } = req.body;
    if (password !== confirmPassword) return res.redirect('/register?error=Passwords do not match!');
    if (username.length < 3 || password.length < 6) return res.redirect('/register?error=Username min 3 chars, Password min 6 chars');
    
    const existing = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (existing) return res.redirect('/register?error=Username already taken!');
    
    await User.create({
        username: username,
        password: bcrypt.hashSync(password, 10),
        role: 'USER'
    });
    res.redirect('/login?registered=1');
});

// ==================== LOGOUT ====================
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ==================== DASHBOARD ====================
app.get('/', requireLogin, async (req, res) => {
    const scripts = await Script.find({ owner: req.session.user.username }).sort({ createdAt: -1 });
    const totalScripts = await Script.countDocuments();
    const myScriptCount = scripts.length;
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
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
            .badge { background: #00ff88; color: black; padding: 5px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
            .stats { display: flex; gap: 15px; margin: 20px 0; flex-wrap: wrap; }
            .stat-box { background: #1a1a1a; padding: 20px; border-radius: 10px; border: 1px solid #333; flex: 1; text-align: center; min-width: 150px; }
            .stat-box h3 { color: #00ff88; font-size: 32px; margin: 0; }
            .stat-box p { color: #888; margin: 5px 0 0 0; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>ShieldHub</h1>
            <div>
                <span>${req.session.user.username}</span>
                <span class="badge">${req.session.user.role}</span>
                ${req.session.user.role === 'OWNER' || req.session.user.role === 'ADMIN' ? '<a href="/admin" class="btn" style="margin-left: 10px;">Admin Panel</a>' : ''}
                <a href="/profile" class="btn" style="margin-left: 10px;">Profile</a>
                <a href="/change-password" class="btn" style="margin-left: 10px;">Change Password</a>
                <a href="/logout" class="btn btn-red" style="margin-left: 10px;">Logout</a>
            </div>
        </div>

        <div class="stats">
            <div class="stat-box">
                <h3>${myScriptCount}</h3>
                <p>Your Scripts</p>
            </div>
            <div class="stat-box">
                <h3>${totalScripts}</h3>
                <p>Total Scripts</p>
            </div>
        </div>

        <h2>My Pastes</h2>
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
    
    if (scripts.length === 0) {
        html += `<div class="card"><p style="color: #888;">No scripts yet. Create one above!</p></div>`;
    } else {
        scripts.forEach(s => {
            html += `
            <div class="card">
                <h3>📄 ${s.name}</h3>
                <p style="color: #888; font-size: 12px;">Created: ${new Date(s.createdAt).toLocaleDateString()}</p>
                <p style="color: #888; font-size: 12px;">ID: <code>${s.token.slice(0, 10)}...</code></p>
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
            if (confirm('⚠️ Sigurado ka bang gusto mong i-delete ang script na "' + name + '"?\\n\\nHindi na ito maibabalik!')) {
                window.location.href = '/delete/' + token;
            }
        }
    </script>
    </body></html>
    `;
    res.send(html);
});

// ==================== CREATE SCRIPT ====================
app.post('/create', requireLogin, async (req, res) => {
    const { name, content } = req.body;
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    await Script.create({
        name, content, token,
        owner: req.session.user.username
    });
    res.redirect('/');
});

// ==================== EDIT SCRIPT ====================
app.get('/edit/:token', requireLogin, async (req, res) => {
    const script = await Script.findOne({ token: req.params.token });
    if (!script) return res.status(404).send("Script not found");
    
    if (script.owner !== req.session.user.username && req.session.user.role !== 'OWNER' && req.session.user.role !== 'ADMIN') {
        return res.status(403).send("Access Denied");
    }

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - Edit Script</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; padding: 20px; }
            .header { display: flex; justify-content: space-between; align-items: center; background: #111; padding: 15px; border-radius: 10px; }
            .card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin: 10px 0; border: 1px solid #333; }
            .btn { background: #00ff88; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; }
            .btn-red { background: #ff4444; color: white; }
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
                <label>Script Content:</label>
                <textarea name="content" rows="20" required>${script.content}</textarea>
                <button type="submit" class="btn">💾 Save Changes</button>
            </form>
        </div>
    </body>
    </html>
    `);
});

app.post('/edit/:token', requireLogin, async (req, res) => {
    const script = await Script.findOne({ token: req.params.token });
    if (!script) return res.status(404).send("Script not found");
    
    if (script.owner !== req.session.user.username && req.session.user.role !== 'OWNER' && req.session.user.role !== 'ADMIN') {
        return res.status(403).send("Access Denied");
    }

    script.name = req.body.name;
    script.content = req.body.content;
    await script.save();
    res.redirect('/');
});

// ==================== PROTECTED VIEW PAGE ====================
app.get('/view/:token', async (req, res) => {
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
                <small>Hindi makikita ang totoong code dito.</small>
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

// ==================== RAW ENDPOINT ====================
app.get('/raw/:token', async (req, res) => {
    const script = await Script.findOne({ token: req.params.token });
    if (!script) return res.status(403).send("-- Access Denied --");
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(script.content);
});

// ==================== DELETE SCRIPT ====================
app.get('/delete/:token', requireLogin, async (req, res) => {
    const script = await Script.findOne({ token: req.params.token });
    if (!script) return res.redirect('/');
    
    if (script.owner !== req.session.user.username && req.session.user.role !== 'OWNER' && req.session.user.role !== 'ADMIN') {
        return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Access Denied</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
            h1 { color: #ff4444; }
            a { color: #00ff88; text-decoration: none; }
        </style>
        </head>
        <body>
            <div>
                <h1>⛔ Access Denied</h1>
                <p>Hindi mo pwedeng i-delete ang script na ito.</p>
                <a href="/">← Back to Dashboard</a>
            </div>
        </body>
        </html>
        `);
    }
    
    await Script.deleteOne({ token: req.params.token });
    res.redirect('/');
});

// ==================== CHANGE PASSWORD ====================
app.get('/change-password', requireLogin, (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - Change Password</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .container { background: #111; padding: 40px; border-radius: 15px; border: 1px solid #333; width: 350px; }
            h1 { color: #00ff88; text-align: center; }
            input { width: 100%; padding: 12px; margin: 8px 0; background: #222; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; }
            .btn { background: #00ff88; color: black; padding: 12px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; width: 100%; font-size: 16px; margin-top: 10px; }
            .msg { text-align: center; margin-top: 10px; color: #00ff88; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Change Password</h1>
            <form action="/change-password" method="POST">
                <input type="password" name="oldPassword" placeholder="Current Password" required>
                <input type="password" name="newPassword" placeholder="New Password" required>
                <input type="password" name="confirmPassword" placeholder="Confirm New Password" required>
                <button type="submit" class="btn">Update Password</button>
            </form>
            <p class="msg">${req.query.msg || ''}</p>
            <a href="/" style="color: #00ff88; display: block; text-align: center; margin-top: 15px;">Back to Dashboard</a>
        </div>
    </body>
    </html>
    `);
});

app.post('/change-password', requireLogin, async (req, res) => {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) return res.redirect('/change-password?msg=Passwords do not match!');
    
    const user = await User.findOne({ username: req.session.user.username });
    if (!bcrypt.compareSync(oldPassword, user.password)) {
        return res.redirect('/change-password?msg=Current password is incorrect!');
    }
    
    user.password = bcrypt.hashSync(newPassword, 10);
    await user.save();
    res.redirect('/change-password?msg=Password updated successfully!');
});

// ==================== ADMIN PANEL ====================
app.get('/admin', requireLogin, async (req, res) => {
    if (req.session.user.role !== 'OWNER' && req.session.user.role !== 'ADMIN') {
        return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Access Denied</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
            h1 { color: #ff4444; }
            a { color: #00ff88; text-decoration: none; }
        </style>
        </head>
        <body>
            <div>
                <h1>⛔ Access Denied</h1>
                <p>Owner or Admin only.</p>
                <a href="/">← Back to Dashboard</a>
            </div>
        </body>
        </html>
        `);
    }

    const scripts = await Script.find().sort({ createdAt: -1 });
    const users = await User.find();

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - Admin Panel</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; padding: 20px; }
            .header { display: flex; justify-content: space-between; align-items: center; background: #111; padding: 15px; border-radius: 10px; flex-wrap: wrap; gap: 10px; }
            .card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin: 10px 0; border: 1px solid #333; }
            .btn { background: #00ff88; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; }
            .btn-red { background: #ff4444; color: white; }
            .badge { background: #00ff88; color: black; padding: 5px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
            .stats { display: flex; gap: 15px; margin: 20px 0; flex-wrap: wrap; }
            .stat-box { background: #1a1a1a; padding: 20px; border-radius: 10px; border: 1px solid #333; flex: 1; text-align: center; min-width: 150px; }
            .stat-box h3 { color: #00ff88; font-size: 32px; margin: 0; }
            .stat-box p { color: #888; margin: 5px 0 0 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
            th { color: #00ff88; }
            .owner { color: #ffcc00; font-weight: bold; }
            .user { color: #00ff88; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>ShieldHub Admin</h1>
            <div>
                <span>${req.session.user.username}</span>
                <span class="badge">${req.session.user.role}</span>
                <a href="/" class="btn" style="margin-left: 10px;">Dashboard</a>
                <a href="/logout" class="btn btn-red" style="margin-left: 10px;">Logout</a>
            </div>
        </div>

        <div class="stats">
            <div class="stat-box">
                <h3>${scripts.length}</h3>
                <p>Total Scripts</p>
            </div>
            <div class="stat-box">
                <h3>${users.length}</h3>
                <p>Total Users</p>
            </div>
            <div class="stat-box">
                <h3>${users.filter(u => u.role === 'OWNER').length}</h3>
                <p>Owners</p>
            </div>
        </div>

        <h2>📜 All Scripts</h2>
    `;

    if (scripts.length === 0) {
        html += `<div class="card"><p style="color: #888;">No scripts yet.</p></div>`;
    } else {
        html += `<div class="card"><table><tr><th>Name</th><th>Owner</th><th>URL</th><th>Actions</th></tr>`;
        scripts.forEach(s => {
            const ownerRole = users.find(u => u.username === s.owner)?.role || 'USER';
            const ownerClass = ownerRole === 'OWNER' ? 'owner' : 'user';
            html += `
            <tr>
                <td>${s.name}</td>
                <td class="${ownerClass}">${s.owner} (${ownerRole})</td>
                <td><code style="font-size: 12px;">/raw/${s.token.slice(0, 10)}...</code></td>
                <td>
                    <a href="/view/${s.token}" class="btn" target="_blank" style="padding: 5px 10px; font-size: 12px;">View</a>
                    <a href="/delete/${s.token}" class="btn btn-red" style="padding: 5px 10px; font-size: 12px;">Delete</a>
                </td>
            </tr>
            `;
        });
        html += `</table></div>`;
    }

    html += `<h2>👥 All Users</h2>`;
    html += `<div class="card"><table><tr><th>Username</th><th>Role</th><th>Actions</th></tr>`;
    users.forEach(u => {
        const roleClass = u.role === 'OWNER' ? 'owner' : 'user';
        html += `
        <tr>
            <td class="${roleClass}">${u.username}</td>
            <td>${u.role}</td>
            <td>
                ${u.username !== req.session.user.username && req.session.user.role === 'OWNER' ? `<a href="/admin/promote/${u.username}" class="btn" style="padding: 5px 10px; font-size: 12px;">Promote</a>` : '<span style="color: #888;">—</span>'}
            </td>
        </tr>
        `;
    });
    html += `</table></div>`;

    html += `</body></html>`;
    res.send(html);
});

// ==================== PROMOTE USER ====================
app.get('/admin/promote/:username', requireLogin, async (req, res) => {
    if (req.session.user.role !== 'OWNER') return res.status(403).send("Access Denied");
    const user = await User.findOne({ username: req.params.username });
    if (user) {
        user.role = user.role === 'USER' ? 'ADMIN' : (user.role === 'ADMIN' ? 'OWNER' : 'USER');
        await user.save();
    }
    res.redirect('/admin');
});

// ==================== USER PROFILE ====================
app.get('/profile', requireLogin, async (req, res) => {
    const myScripts = await Script.find({ owner: req.session.user.username });
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - Profile</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; padding: 20px; }
            .header { display: flex; justify-content: space-between; align-items: center; background: #111; padding: 15px; border-radius: 10px; flex-wrap: wrap; gap: 10px; }
            .card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin: 10px 0; border: 1px solid #333; }
            .btn { background: #00ff88; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; }
            .badge { background: #00ff88; color: black; padding: 5px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
            .avatar { width: 80px; height: 80px; background: #00ff88; border-radius: 50%; display: flex; justify-content: center; align-items: center; font-size: 32px; color: black; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>ShieldHub</h1>
            <div>
                <a href="/" class="btn">Dashboard</a>
                <a href="/logout" class="btn" style="background: #ff4444; color: white;">Logout</a>
            </div>
        </div>
        <div class="card" style="text-align: center;">
            <div class="avatar" style="margin: 0 auto;">${req.session.user.username[0].toUpperCase()}</div>
            <h2>${req.session.user.username}</h2>
            <span class="badge">${req.session.user.role}</span>
            <p style="color: #888; margin-top: 15px;">Total Scripts: <strong style="color: #00ff88;">${myScripts.length}</strong></p>
        </div>
        <h3>Your Scripts</h3>
        ${myScripts.length === 0 ? '<div class="card"><p style="color: #888;">No scripts yet.</p></div>' : ''}
        ${myScripts.map(s => `
            <div class="card">
                <h4>${s.name}</h4>
                <p><code>${baseUrl}/raw/${s.token}</code></p>
            </div>
        `).join('')}
    </body>
    </html>
    `);
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`✅ ShieldHub running on port ${PORT}`);
});
