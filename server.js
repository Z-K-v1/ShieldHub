const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'shieldhub-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

const DB_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// --- HELPER FUNCTIONS ---
function readDB() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));
    return JSON.parse(fs.readFileSync(DB_FILE));
}
function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function readUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        const defaultUsers = [{
            username: 'Zyrox',
            password: bcrypt.hashSync('admin123', 10),
            role: 'OWNER'
        }];
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        return defaultUsers;
    }
    return JSON.parse(fs.readFileSync(USERS_FILE));
}
function writeUsers(data) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function requireLogin(req, res, next) {
    if (req.session.user) next();
    else res.redirect('/login');
}

// --- ROUTES ---

// 1. LOGIN PAGE
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

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = readUsers();
    const user = users.find(u => u.username === username);
    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.user = { username: user.username, role: user.role };
        res.redirect('/');
    } else {
        res.redirect('/login?error=1');
    }
});

// 2. REGISTER PAGE
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

app.post('/register', (req, res) => {
    const { username, password, confirmPassword } = req.body;
    if (password !== confirmPassword) return res.redirect('/register?error=Passwords do not match!');
    if (username.length < 3 || password.length < 6) return res.redirect('/register?error=Username min 3 chars, Password min 6 chars');
    
    const users = readUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.redirect('/register?error=Username already taken!');
    }
    
    users.push({
        username: username,
        password: bcrypt.hashSync(password, 10),
        role: 'USER'
    });
    writeUsers(users);
    res.redirect('/login?registered=1');
});

// 3. LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 4. DASHBOARD (Protected)
app.get('/', requireLogin, (req, res) => {
    const scripts = readDB();
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>ShieldHub - Dashboard</title>
        <style>
            body { background: #0a0a0a; color: white; font-family: sans-serif; padding: 20px; }
            .header { display: flex; justify-content: space-between; align-items: center; background: #111; padding: 15px; border-radius: 10px; }
            .card { background: #1a1a1a; padding: 20px; border-radius: 10px; margin: 10px 0; border: 1px solid #333; }
            .btn { background: #00ff88; color: black; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; }
            .btn-red { background: #ff4444; color: white; }
            input, textarea { width: 100%; padding: 10px; margin: 5px 0; background: #222; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; }
            .badge { background: #00ff88; color: black; padding: 5px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>ShieldHub</h1>
            <div>
                <span>${req.session.user.username}</span>
                <span class="badge">${req.session.user.role}</span>
                <a href="/change-password" class="btn" style="margin-left: 10px;">Change Password</a>
                <a href="/logout" class="btn btn-red" style="margin-left: 10px;">Logout</a>
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
    scripts.forEach(s => {
        html += `
        <div class="card">
            <h3>${s.name}</h3>
            <p>URL: <code>${baseUrl}/raw/${s.token}</code></p>
            <a href="/view/${s.token}" class="btn" target="_blank">View</a>
            <a href="/delete/${s.token}" class="btn btn-red">Delete</a>
        </div>
        `;
    });
    html += `</body></html>`;
    res.send(html);
});

// 5. CREATE SCRIPT (Protected)
app.post('/create', requireLogin, (req, res) => {
    const { name, content } = req.body;
    const scripts = readDB();
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    scripts.push({ name, content, token, owner: req.session.user.username, createdAt: new Date() });
    writeDB(scripts);
    res.redirect('/');
});

// 6. PROTECTED VIEW PAGE (Public)
app.get('/view/:token', (req, res) => {
    const scripts = readDB();
    const script = scripts.find(s => s.token === req.params.token);
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

// 7. RAW ENDPOINT (CLEAN URL)
app.get('/raw/:token', (req, res) => {
    const scripts = readDB();
    const script = scripts.find(s => s.token === req.params.token);
    if (!script) return res.status(403).send("-- Access Denied --");
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(script.content);
});

// 8. DELETE SCRIPT (Protected)
app.get('/delete/:token', requireLogin, (req, res) => {
    let scripts = readDB();
    scripts = scripts.filter(s => s.token !== req.params.token);
    writeDB(scripts);
    res.redirect('/');
});

// 9. CHANGE PASSWORD PAGE
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
            .err { color: #ff4444; }
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

app.post('/change-password', requireLogin, (req, res) => {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) return res.redirect('/change-password?msg=Passwords do not match!');
    
    const users = readUsers();
    const userIndex = users.findIndex(u => u.username === req.session.user.username);
    
    if (!bcrypt.compareSync(oldPassword, users[userIndex].password)) {
        return res.redirect('/change-password?msg=Current password is incorrect!');
    }
    
    users[userIndex].password = bcrypt.hashSync(newPassword, 10);
    writeUsers(users);
    res.redirect('/change-password?msg=Password updated successfully!');
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`✅ ShieldHub running on port ${PORT}`);
    console.log(`👤 Default login: Zyrox / admin123`);
});
