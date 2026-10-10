const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('❌ DATABASE_URL not set!'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ==================== ICON / FAVICON (inline SVG base64) ====================
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff3b3b"/><stop offset="100%" stop-color="#cc0000"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#g)"/><path d="M30 30 L50 50 L30 70 M70 30 L50 50 L70 70" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
const FAVICON_DATA = 'data:image/svg+xml;base64,' + Buffer.from(FAVICON_SVG).toString('base64');
const DEFAULT_ICON = FAVICON_DATA;

// ==================== DATABASE INIT ====================
async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role VARCHAR(20) DEFAULT 'USER', created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS scripts (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, version VARCHAR(50) DEFAULT 'V1', real_content TEXT NOT NULL, token VARCHAR(64) UNIQUE NOT NULL, owner VARCHAR(50) NOT NULL, access_type VARCHAR(20) DEFAULT 'public', allowed_ids TEXT DEFAULT '[]', short_id VARCHAR(32), icon TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS "session" ("sid" VARCHAR NOT NULL COLLATE "default", "sess" JSON NOT NULL, "expire" TIMESTAMP(6) NOT NULL, CONSTRAINT "session_pkey" PRIMARY KEY ("sid"));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS execution_logs (id SERIAL PRIMARY KEY, script_id INTEGER NOT NULL, user_id VARCHAR(30) NOT NULL, username VARCHAR(100) DEFAULT '', allowed BOOLEAN DEFAULT FALSE, kicked BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS servers (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, owner VARCHAR(50) NOT NULL, invite_code VARCHAR(16) UNIQUE NOT NULL, icon VARCHAR(10) DEFAULT '🎮', created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS server_members (id SERIAL PRIMARY KEY, server_id INTEGER NOT NULL, username VARCHAR(50) NOT NULL, role VARCHAR(20) DEFAULT 'MEMBER', joined_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS channels (id SERIAL PRIMARY KEY, server_id INTEGER NOT NULL, name VARCHAR(50) NOT NULL, type VARCHAR(10) DEFAULT 'text', created_by VARCHAR(50) NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, channel_id INTEGER NOT NULL, username VARCHAR(50) NOT NULL, role VARCHAR(20) DEFAULT 'USER', message TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);

        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS short_id VARCHAR(32);`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '';`);

        const noShort = await pool.query(`SELECT id FROM scripts WHERE short_id IS NULL`);
        for (const row of noShort.rows) {
            let shortId; let exists = true;
            while (exists) {
                shortId = crypto.randomBytes(5).toString('hex');
                const c = await pool.query('SELECT id FROM scripts WHERE short_id = $1', [shortId]);
                exists = c.rows.length > 0;
            }
            await pool.query('UPDATE scripts SET short_id = $1 WHERE id = $2', [shortId, row.id]);
        }

        console.log('✅ DB ready');
        const adminPass = process.env.ADMIN_PASSWORD;
        if (adminPass) {
            const ex = await pool.query('SELECT * FROM users WHERE username = $1', ['Z-K']);
            if (ex.rows.length === 0) {
                await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', ['Z-K', adminPass, 'ADMIN']);
            }
        }
    } catch (e) { console.error('❌ DB error:', e.message); }
}
initDB();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({ store: new pgSession({ pool, tableName: 'session' }), secret: process.env.SESSION_SECRET || 'zyrox-kido-secret', resave: false, saveUninitialized: false, cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } }));

function requireLogin(req, res, next) { if (req.session.user) next(); else res.redirect('/login'); }
function requireAdmin(req, res, next) { if (req.session.user && req.session.user.role === 'ADMIN') next(); else res.status(403).send('Access Denied'); }

const BRAND_NAME = 'By Zyrox-Kido';
const BRAND_SHORT = 'Zyrox-Kido';

function getBaseUrl() {
    return process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
}

function makeShortId() { return crypto.randomBytes(5).toString('hex'); }
function makeInvite() { return crypto.randomBytes(4).toString('hex'); }

// ==================== LOADSTRING BUILDER ====================
function buildLoadstring(name, version, shortId) {
    const cleanName = (name || 'SCRIPT').toUpperCase().replace(/[^A-Z0-9_-]/g, '_').substring(0, 30) || 'SCRIPT';
    const cleanVer = (version || 'V1').toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'V1';
    const base = getBaseUrl();
    return "loadstring(game:HttpGet('" + base + "/" + cleanName + "/" + cleanVer + "/id=" + shortId + "'))()";
}

// ==================== AUTO-DETECT USERID WRAPPER ====================
function buildWhitelistWrapper(shortId) {
    const base = getBaseUrl();
    return '-- [ShieldHub Protection]\n' +
'local _sh_userId = tostring(game.Players.LocalPlayer.UserId)\n' +
'local _sh_username = game.Players.LocalPlayer.Name\n' +
'local _sh_req = (syn and syn.request) or (http and http.request) or http_request or request\n' +
'if not _sh_req then\n' +
'    pcall(function() game.Players.LocalPlayer:Kick("[ShieldHub] Executor not supported.") end)\n' +
'    return\n' +
'end\n' +
'local _sh_res = nil\n' +
'pcall(function()\n' +
'    _sh_res = _sh_req({\n' +
'        Url = "' + base + '/api/verify?id=' + shortId + '&userId=" .. _sh_userId .. "&username=" .. _sh_username,\n' +
'        Method = "GET"\n' +
'    })\n' +
'end)\n' +
'if not _sh_res or not _sh_res.Body or _sh_res.Body == "" or string.find(_sh_res.Body, "ACCESS_DENIED") then\n' +
'    pcall(function() game.Players.LocalPlayer:Kick("[ShieldHub] You are NOT whitelisted for this script.") end)\n' +
'    return\n' +
'end\n' +
'local _sh_fn = loadstring(_sh_res.Body)\n' +
'if _sh_fn then pcall(_sh_fn) end\n';
}

// ==================== FAVICON ROUTE ====================
app.get('/favicon.ico', function(req, res) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(FAVICON_SVG);
});
app.get('/favicon.svg', function(req, res) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(FAVICON_SVG);
});

const LAYOUT_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#080404;--bg1:#0e0707;--bg2:#160b0b;--bg3:#1f0f0f;--border:rgba(255,255,255,0.06);--border1:rgba(255,255,255,0.1);--text:#fff;--text1:#e0e0e0;--text2:#9a9a9a;--text3:#5a5a5a;--red:#ff3b3b;--red2:#cc0000;--red-dim:rgba(255,59,59,0.12);--purple:#b855ff;--green:#22c55e;--yellow:#ffbb44}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.6;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 1000px 800px at 10% -10%,rgba(255,59,59,0.18),transparent 55%),radial-gradient(ellipse 1000px 800px at 90% 110%,rgba(184,85,255,0.12),transparent 55%);pointer-events:none;z-index:0}
a{color:inherit;text-decoration:none}button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
input,textarea,select{font-family:inherit;width:100%;padding:13px 15px;background:rgba(0,0,0,0.4);border:1px solid var(--border);border-radius:11px;color:var(--text);font-size:15px;outline:none;min-height:48px}
input:focus,textarea:focus,select:focus{border-color:var(--red);box-shadow:0 0 0 4px var(--red-dim)}
textarea{font-family:'JetBrains Mono',monospace;font-size:12.5px;min-height:300px;resize:vertical}
.layout{display:flex;min-height:100vh;position:relative;z-index:1}
.sidebar{width:270px;background:rgba(15,8,8,0.95);backdrop-filter:blur(30px);border-right:1px solid var(--border);padding:22px 14px;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50}
.brand{display:flex;align-items:center;gap:11px;padding:6px 10px 18px;border-bottom:1px solid var(--border);margin-bottom:16px}
.brand-logo{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;font-weight:900;font-size:17px;color:#fff;box-shadow:0 8px 24px rgba(255,59,59,0.4);animation:logoGlow 3s infinite alternate;overflow:hidden}
.brand-logo img{width:100%;height:100%;object-fit:cover}
@keyframes logoGlow{0%{box-shadow:0 8px 24px rgba(255,59,59,0.4)}100%{box-shadow:0 8px 32px rgba(255,59,59,0.7)}}
.brand-name{font-size:16px;font-weight:800}
.brand-sub{font-size:10px;color:var(--text3);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-top:3px}
.nav-label{font-size:10px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:1.2px;padding:14px 12px 6px}
.nav-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;font-size:14px;font-weight:600;color:var(--text1);margin-bottom:3px;transition:all 0.2s;border:1px solid transparent}
.nav-item:hover{background:var(--bg2);color:var(--text);transform:translateX(3px)}
.nav-item.active{background:var(--red-dim);color:var(--red);border-left:3px solid var(--red)}
.sidebar-footer{margin-top:auto;padding-top:16px;border-top:1px solid var(--border)}
.user-card{display:flex;align-items:center;gap:11px;padding:12px;border-radius:12px;background:var(--bg2)}
.user-avatar{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:15px}
.user-avatar-admin{background:linear-gradient(135deg,#ffaa00,#ff6600)}
.user-name{font-size:14px;font-weight:700}
.user-role{font-size:10px;color:var(--text3);font-weight:800;text-transform:uppercase}
.main{flex:1;margin-left:270px;display:flex;flex-direction:column}
.topbar{height:66px;background:rgba(10,5,5,0.85);backdrop-filter:blur(30px);border-bottom:1px solid var(--border);padding:0 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:40}
.topbar-title{font-size:15px;font-weight:700}
.content{padding:36px;flex:1;max-width:1400px;width:100%;margin:0 auto}
.page-title{font-size:36px;font-weight:800;letter-spacing:-1.2px;background:linear-gradient(135deg,#fff 0%,#ff5555 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}
.page-sub{font-size:13.5px;color:var(--text2);margin-bottom:28px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 22px;border-radius:12px;font-weight:700;font-size:13px;cursor:pointer;border:1px solid transparent;min-height:46px;transition:all 0.2s;text-decoration:none}
.btn-primary{background:linear-gradient(135deg,var(--red),var(--red2));color:#fff;box-shadow:0 6px 24px rgba(255,59,59,0.35)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 36px rgba(255,59,59,0.5)}
.btn-secondary{background:var(--bg2);color:var(--text);border-color:var(--border)}
.btn-danger{background:rgba(255,59,59,0.1);color:#ff5555;border-color:rgba(255,59,59,0.25)}
.btn-ghost{background:transparent;color:var(--text1);border-color:var(--border)}
.btn-sm{padding:9px 14px;font-size:12px;min-height:38px}
.btn-success{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff}
.card{background:linear-gradient(180deg,rgba(22,11,11,0.7),rgba(10,5,5,0.9));border:1px solid var(--border);border-radius:18px;padding:28px;margin-bottom:16px}
.badge{display:inline-flex;align-items:center;padding:4px 11px;border-radius:8px;font-size:10.5px;font-weight:800;border:1px solid transparent}
.badge-purple{background:rgba(184,85,255,0.15);color:#d4a3ff}
.badge-green{background:rgba(34,197,94,0.15);color:#4ade80}
.badge-yellow{background:rgba(255,170,0,0.15);color:#ffcc66}
.badge-red{background:rgba(255,59,59,0.15);color:#ff6666}
.badge-admin{background:rgba(255,170,0,0.15);color:#ffcc66}
.form-group{margin-bottom:20px}
.form-label{display:block;font-size:12px;font-weight:700;color:var(--text1);margin-bottom:9px;text-transform:uppercase;letter-spacing:0.5px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.grid-scripts{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px}
.grid-servers{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.id-row{display:flex;gap:10px;margin-bottom:10px}
.id-row input{flex:1;font-family:'JetBrains Mono',monospace}
.id-row button{width:48px;height:48px;border-radius:11px;background:rgba(220,38,38,0.15);border:1px solid rgba(220,38,38,0.35);color:#ff5555;font-size:20px;flex-shrink:0}
.script-icon{width:52px;height:52px;border-radius:13px;object-fit:cover;flex-shrink:0;border:1px solid var(--border1);background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:22px;overflow:hidden}
.script-icon img{width:100%;height:100%;object-fit:cover;display:block}
.icon-preview{width:80px;height:80px;border-radius:16px;object-fit:cover;border:1px solid var(--border1);background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:32px;margin-bottom:12px;overflow:hidden}
.icon-preview img{width:100%;height:100%;object-fit:cover;display:block}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{background:linear-gradient(180deg,rgba(22,11,11,0.85),rgba(10,5,5,0.95));border:1px solid var(--border1);border-radius:22px;padding:44px 40px;width:440px;max-width:100%}
.login-logo{width:76px;height:76px;border-radius:20px;background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:28px;color:#fff;margin:0 auto 18px;box-shadow:0 12px 40px rgba(255,59,59,0.5);overflow:hidden}
.login-logo img{width:100%;height:100%;object-fit:cover}
.login-title{font-size:26px;font-weight:800;text-align:center;margin-bottom:6px}
.login-sub{font-size:13.5px;color:var(--text2);text-align:center;margin-bottom:30px}
.login-card input{margin-bottom:12px}
.login-err{color:#ff5555;text-align:center;font-size:12.5px;font-weight:700;min-height:18px;margin-top:10px}
.login-link{display:block;text-align:center;margin-top:18px;font-size:13px;color:var(--red);font-weight:700}
.copy-box{display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,0.5);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#ff5555;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%}
.empty{text-align:center;padding:70px 30px;border:1px dashed var(--border);border-radius:16px}
.empty-icon{font-size:44px;margin-bottom:16px;opacity:0.5}
.log-item{display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:12px;margin-bottom:8px;border:1px solid}
.log-allowed{border-color:rgba(34,197,94,0.3);background:rgba(34,197,94,0.05)}
.log-kicked{border-color:rgba(220,38,38,0.4);background:rgba(220,38,38,0.08)}
.log-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff}
.log-icon.allowed{background:linear-gradient(135deg,#22c55e,#16a34a)}
.log-icon.kicked{background:linear-gradient(135deg,#dc2626,#991b1b)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:28px}
.stat{background:linear-gradient(180deg,rgba(22,11,11,0.7),rgba(10,5,5,0.9));border:1px solid var(--border);border-radius:14px;padding:22px}
.stat-label{font-size:11px;color:var(--text3);font-weight:800;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.stat-value{font-size:28px;font-weight:800}
.chat-layout{display:grid;grid-template-columns:240px 1fr 200px;background:var(--bg1);border:1px solid var(--border);border-radius:16px;overflow:hidden;height:calc(100vh - 260px);min-height:500px}
.chat-sidebar{background:var(--bg);border-right:1px solid var(--border);display:flex;flex-direction:column}
.chat-sidebar-header{padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.channel-group-label{font-size:10px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:1px;padding:12px 14px 6px;display:flex;justify-content:space-between}
.channel-item{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;cursor:pointer;color:var(--text2);font-size:13px;font-weight:600;margin:2px 6px;justify-content:space-between}
.channel-item:hover{background:var(--bg2);color:var(--text)}
.channel-item.active{background:var(--red-dim);color:var(--red)}
.channel-item-left{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.channel-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.channel-delete{width:22px;height:22px;border-radius:5px;color:var(--text3);font-size:12px;display:flex;align-items:center;justify-content:center;opacity:0}
.channel-item:hover .channel-delete{opacity:1}
.channel-delete:hover{background:rgba(220,38,38,0.3);color:#ff5555}
.chat-main{display:flex;flex-direction:column;min-width:0}
.chat-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--bg)}
.chat-messages{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px}
.chat-message{display:flex;gap:10px;align-items:flex-start}
.msg-avatar{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex-shrink:0}
.msg-body{flex:1;min-width:0}
.msg-meta{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.msg-username{font-weight:700;font-size:13px}
.msg-time{font-size:10.5px;color:var(--text3);font-weight:600}
.msg-content{font-size:13.5px;line-height:1.5;word-wrap:break-word}
.chat-input-area{padding:14px 18px;border-top:1px solid var(--border);background:var(--bg)}
.chat-input-area form{display:flex;gap:10px}
.chat-input-area input{flex:1;margin:0;background:var(--bg2);border-color:transparent}
.members-list{padding:12px;overflow-y:auto;border-left:1px solid var(--border);background:var(--bg)}
.member-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:12.5px;font-weight:600;color:var(--text1);margin-bottom:2px}
.member-avatar{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#fff;flex-shrink:0}
@media(max-width:900px){.sidebar{transform:translateX(-100%)}.main{margin-left:0}.content{padding:20px}.page-title{font-size:26px}.grid-2{grid-template-columns:1fr}.grid-scripts{grid-template-columns:1fr}.chat-layout{grid-template-columns:1fr}.members-list{display:none}}
`;

const TOAST_SCRIPT = `function copyText(t){navigator.clipboard.writeText(t).then(function(){alert('✅ Copied!')})}function confirmDelete(i,n){if(confirm('Delete "'+n+'"?'))window.location.href='/delete/'+i}`;

function renderLayout(opts) {
    var title = opts.title, pageTitle = opts.pageTitle, pageSubtitle = opts.pageSubtitle, content = opts.content, user = opts.user, activeNav = opts.activeNav, actions = opts.actions;
    var isAdmin = user.role === 'ADMIN';
    var adminLink = isAdmin ? '<div class="nav-label">Admin</div><a href="/admin" class="nav-item ' + (activeNav === 'admin' ? 'active' : '') + '">♛ Admin Panel</a>' : '';
    var faviconLink = '<link rel="icon" type="image/svg+xml" href="' + FAVICON_DATA + '">';
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + ' · ' + BRAND_SHORT + '</title>' + faviconLink + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet"><style>' + LAYOUT_STYLES + '</style></head><body><div class="layout"><aside class="sidebar"><div class="brand"><div class="brand-logo"><img src="' + FAVICON_DATA + '" alt="ZK"></div><div><div class="brand-name">' + BRAND_SHORT + '</div><div class="brand-sub">By Zyrox-Kido</div></div></div><div class="nav-label">Workspace</div><a href="/" class="nav-item ' + (activeNav === 'dashboard' ? 'active' : '') + '">◈ Dashboard</a><a href="/create" class="nav-item ' + (activeNav === 'create' ? 'active' : '') + '">✦ Create Script</a><a href="/servers" class="nav-item ' + (activeNav === 'servers' ? 'active' : '') + '">🏠 Servers</a>' + adminLink + '<div class="sidebar-footer"><a href="/logout" class="user-card"><div class="user-avatar ' + (isAdmin ? 'user-avatar-admin' : '') + '">' + user.username[0].toUpperCase() + '</div><div><div class="user-name">' + user.username + '</div><div class="user-role">' + (isAdmin ? '♛ Admin' : 'Member') + '</div></div></a></div></aside><div class="main"><header class="topbar"><div class="topbar-title">' + pageTitle + '</div></header><div class="content"><div class="page-title">' + pageTitle + '</div>' + (pageSubtitle ? '<div class="page-sub">' + pageSubtitle + '</div>' : '') + (actions || '') + content + '</div></div></div><script>' + TOAST_SCRIPT + '</script></body></html>';
}

// ==================== ICON RENDER ====================
function renderScriptIcon(icon, fallbackText) {
    var src = (icon && icon.trim()) ? icon.trim() : FAVICON_DATA;
    var fallback = (fallbackText || '◈').replace(/"/g, '');
    return '<div class="script-icon"><img src="' + src.replace(/"/g, '&quot;') + '" onerror="this.onerror=null;this.parentNode.innerHTML=\'' + fallback + '\'" alt=""></div>';
}

// ==================== AUTH ====================
app.get('/login', function(req, res) {
    var faviconLink = '<link rel="icon" type="image/svg+xml" href="' + FAVICON_DATA + '">';
    res.send('<!DOCTYPE html><html><head><title>Login · ' + BRAND_SHORT + '</title>' + faviconLink + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"><style>' + LAYOUT_STYLES + '</style></head><body><div class="login-wrap"><div class="login-card"><div class="login-logo"><img src="' + FAVICON_DATA + '" alt="ZK"></div><div class="login-title">Welcome back</div><div class="login-sub">Sign in to continue</div><form method="POST" action="/login"><input type="text" name="username" placeholder="Username" required autofocus><input type="password" name="password" placeholder="Password" required><button type="submit" class="btn btn-primary" style="width:100%">Sign In →</button></form><div class="login-err">' + (req.query.error ? 'Invalid credentials' : '') + '</div><a href="/register" class="login-link">Create account →</a></div></div></body></html>');
});
app.post('/login', async function(req, res) {
    try { const { username, password } = req.body; const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]); if (r.rows.length === 0) return res.redirect('/login?error=1'); const u = r.rows[0]; if (u.password !== password) return res.redirect('/login?error=1'); req.session.user = { username: u.username, role: u.role }; res.redirect('/'); } catch (e) { res.redirect('/login?error=1'); }
});
app.get('/register', function(req, res) {
    var faviconLink = '<link rel="icon" type="image/svg+xml" href="' + FAVICON_DATA + '">';
    res.send('<!DOCTYPE html><html><head><title>Register · ' + BRAND_SHORT + '</title>' + faviconLink + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"><style>' + LAYOUT_STYLES + '</style></head><body><div class="login-wrap"><div class="login-card"><div class="login-logo"><img src="' + FAVICON_DATA + '" alt="ZK"></div><div class="login-title">Create account</div><div class="login-sub">Join ' + BRAND_SHORT + '</div><form method="POST" action="/register"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><input type="password" name="confirmPassword" placeholder="Confirm password" required><button type="submit" class="btn btn-primary" style="width:100%">Create Account →</button></form><div class="login-err">' + (req.query.error || '') + '</div><a href="/login" class="login-link">← Back to sign in</a></div></div></body></html>');
});
app.post('/register', async function(req, res) {
    try { const { username, password, confirmPassword } = req.body; if (password !== confirmPassword) return res.redirect('/register?error=Passwords do not match'); if (username.length < 2 || password.length < 4) return res.redirect('/register?error=Min 2 chars, 4 chars pass'); const ex = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]); if (ex.rows.length > 0) return res.redirect('/register?error=Username taken'); const role = username === 'Z-K' ? 'ADMIN' : 'USER'; await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, password, role]); res.redirect('/login?registered=1'); } catch (e) { res.redirect('/register?error=Server error'); }
});
app.get('/logout', function(req, res) { req.session.destroy(); res.redirect('/login'); });

// ==================== DASHBOARD ====================
app.get('/', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [req.session.user.username]);
        const myScripts = r.rows;
        const isAdmin = req.session.user.role === 'ADMIN';
        const stats = '<div class="stat-grid"><div class="stat"><div class="stat-label">Total Scripts</div><div class="stat-value">' + myScripts.length + '</div></div><div class="stat"><div class="stat-label">Role</div><div class="stat-value">' + (isAdmin ? 'Admin' : 'Member') + '</div></div><div class="stat"><div class="stat-label">Whitelist</div><div class="stat-value">' + myScripts.filter(s => s.access_type === 'whitelist').length + '</div></div></div>';
        let scriptsHtml = '';
        if (myScripts.length === 0) {
            scriptsHtml = '<div class="empty"><div class="empty-icon">◈</div><div style="font-size:18px;font-weight:700;margin-bottom:8px;">No scripts yet</div><a href="/create" class="btn btn-primary">✦ Create Script</a></div>';
        } else {
            scriptsHtml = '<div class="grid-scripts">';
            for (const s of myScripts) {
                let count = 0; try { count = JSON.parse(s.allowed_ids || '[]').length; } catch(e) {}
                const ls = buildLoadstring(s.name, s.version, s.short_id);
                const badge = s.access_type === 'whitelist' ? '<span class="badge badge-yellow">🔒 Whitelist (' + count + ')</span>' : '<span class="badge badge-green">🌐 Public</span>';
                scriptsHtml += '<div class="card"><div style="display:flex;gap:12px;margin-bottom:14px;">' + renderScriptIcon(s.icon, s.name[0]) + '<div><div style="font-size:16px;font-weight:800;margin-bottom:6px;">' + s.name + '</div><div style="display:flex;gap:6px;">' + badge + '<span class="badge badge-purple">' + s.version + '</span></div></div></div><div class="copy-box" onclick="copyText(\'' + ls.replace(/'/g, "\\'") + '\')">🔗 ' + ls + ' 📋</div><div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="copyText(\'' + ls.replace(/'/g, "\\'") + '\')">📋 Loadstring</button><a href="/logs/' + s.token + '" class="btn btn-secondary btn-sm">📊 Logs</a><a href="/edit/' + s.token + '" class="btn btn-ghost btn-sm">✎ Edit</a><button class="btn btn-danger btn-sm" onclick="confirmDelete(\'' + s.token + '\', \'' + s.name + '\')">🗑</button></div></div>';
            }
            scriptsHtml += '</div>';
        }
        res.send(renderLayout({ title: 'Dashboard', pageTitle: 'Dashboard', pageSubtitle: 'Manage your Lua scripts', content: stats + scriptsHtml, user: req.session.user, activeNav: 'dashboard' }));
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ==================== CREATE ====================
app.get('/create', requireLogin, function(req, res) {
    var verOpts = ''; for (var i = 1; i <= 1000; i++) verOpts += '<option value="V' + i + '">V' + i + '</option>';
    const content = '<div class="card" style="max-width:900px;"><form method="POST" action="/create" onsubmit="return prepareSubmit(this)"><div class="grid-2" style="margin-bottom:18px;"><div class="form-group"><label class="form-label">📝 Script Name</label><input type="text" name="name" required autofocus placeholder="e.g., Fly UI"></div><div class="form-group"><label class="form-label">🏷 Version</label><select name="version" required>' + verOpts + '</select></div></div><div class="form-group"><label class="form-label">🖼️ Icon Image (URL o iwan blangko para sa default)</label><div class="icon-preview" id="iconPreview"><img src="' + FAVICON_DATA + '" alt=""></div><input type="text" id="iconInput" name="icon" placeholder="https://example.com/icon.png (opsyonal)" oninput="updateIconPreview(this.value)"><div style="font-size:12px;color:var(--text3);margin-top:8px;">💡 Mag-upload ng image sa imgur.com o Discord, tapos i-paste ang direct URL dito.</div></div><div class="form-group"><label class="form-label">🔒 Access Type</label><select id="accessType" onchange="updateAccessUI()"><option value="public">🌐 Public (Lahat pwede)</option><option value="whitelist">🔒 Whitelist (May ID check)</option></select></div><div class="form-group" id="idListWrap" style="display:none;"><label class="form-label">👤 Roblox User IDs</label><div id="idList"><div class="id-row"><input type="text" class="id-input" placeholder="Roblox User ID" inputmode="numeric"><button type="button" onclick="removeIdRow(this)">×</button></div></div><button type="button" class="btn btn-success btn-sm" onclick="addIdRow()">+ Add User</button><div style="font-size:12px;color:var(--text3);margin-top:10px;">💡 Ang ID ay HINDI makikita ng player</div></div><input type="hidden" name="access_type" id="accessTypeHidden" value="public"><input type="hidden" name="allowed_ids" id="allowedIdsHidden" value="[]"><div class="form-group"><label class="form-label">📜 Lua Code</label><textarea name="content" required placeholder="-- Isulat ang Lua script dito..."></textarea></div><div style="display:flex;gap:12px;"><button type="submit" class="btn btn-primary">💾 Save</button><a href="/" class="btn btn-ghost">Cancel</a></div></form></div><script>function updateIconPreview(u){var p=document.getElementById("iconPreview");if(u&&u.trim()){p.innerHTML=\'<img src="\'+u.replace(/"/g,"&quot;")+\'" onerror="this.onerror=null;this.parentNode.innerHTML=\'◈\'" alt="">\'}else{p.innerHTML=\'<img src="' + FAVICON_DATA + '" alt="">\'}}function updateAccessUI(){document.getElementById("idListWrap").style.display=document.getElementById("accessType").value==="whitelist"?"block":"none"}function addIdRow(){var l=document.getElementById("idList");var d=document.createElement("div");d.className="id-row";d.innerHTML=\'<input type="text" class="id-input" placeholder="Roblox User ID" inputmode="numeric"><button type="button" onclick="removeIdRow(this)">×</button>\';l.appendChild(d)}function removeIdRow(b){b.parentNode.remove()}function prepareSubmit(){var s=document.getElementById("accessType");document.getElementById("accessTypeHidden").value=s.value;if(s.value==="whitelist"){var ids=[];document.querySelectorAll(".id-input").forEach(function(el){var v=el.value.trim();if(v&&/^[0-9]+$/.test(v))ids.push(v)});document.getElementById("allowedIdsHidden").value=JSON.stringify(ids)}else{document.getElementById("allowedIdsHidden").value="[]"}}document.addEventListener("DOMContentLoaded",updateAccessUI);</script>';
    res.send(renderLayout({ title: 'Create', pageTitle: 'Create Script', pageSubtitle: 'Add a new Lua script', content: content, user: req.session.user, activeNav: 'create' }));
});
app.post('/create', requireLogin, async function(req, res) {
    try {
        const name = req.body.name, version = req.body.version || 'V1', content = req.body.content;
        const icon = (req.body.icon || '').trim().substring(0, 2000);
        const access_type = req.body.access_type || 'public';
        let allowed_ids = req.body.allowed_ids || '[]';
        try { JSON.parse(allowed_ids); } catch(e) { allowed_ids = '[]'; }
        const token = crypto.randomBytes(16).toString('hex');
        let shortId; let exists = true;
        while (exists) { shortId = makeShortId(); const c = await pool.query('SELECT id FROM scripts WHERE short_id = $1', [shortId]); exists = c.rows.length > 0; }
        await pool.query('INSERT INTO scripts (name, version, real_content, token, owner, access_type, allowed_ids, short_id, icon) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [name, version, content, token, req.session.user.username, access_type, allowed_ids, shortId, icon]);
        res.redirect('/');
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ==================== EDIT ====================
app.get('/edit/:token', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (r.rows.length === 0) return res.status(404).send("Not found");
        const s = r.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied");
        const escaped = s.real_content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let ids = []; try { ids = JSON.parse(s.allowed_ids || '[]'); } catch(e) {}
        let idsHtml = ''; for (const i of ids) idsHtml += '<div class="id-row"><input type="text" class="id-input" value="' + i + '" inputmode="numeric"><button type="button" onclick="removeIdRow(this)">×</button></div>';
        if (!idsHtml) idsHtml = '<div class="id-row"><input type="text" class="id-input" placeholder="Roblox User ID" inputmode="numeric"><button type="button" onclick="removeIdRow(this)">×</button></div>';
        const ls = buildLoadstring(s.name, s.version, s.short_id);
        let verOpts = ''; for (let i = 1; i <= 1000; i++) verOpts += '<option value="V' + i + '"' + (s.version === 'V' + i ? ' selected' : '') + '>V' + i + '</option>';
        const currentIcon = (s.icon && s.icon.trim()) ? s.icon : FAVICON_DATA;
        const content = '<div class="card" style="max-width:900px;"><div class="copy-box" onclick="copyText(\'' + ls.replace(/'/g, "\\'") + '\')" style="margin-bottom:18px;">🔗 ' + ls + ' 📋</div><form method="POST" action="/edit/' + s.token + '" onsubmit="return prepareSubmit(this)"><div class="grid-2" style="margin-bottom:18px;"><div class="form-group"><label class="form-label">📝 Name</label><input type="text" name="name" value="' + s.name.replace(/"/g, '&quot;') + '" required></div><div class="form-group"><label class="form-label">🏷 Version</label><select name="version" required>' + verOpts + '</select></div></div><div class="form-group"><label class="form-label">🖼️ Icon Image (URL)</label><div class="icon-preview" id="iconPreview"><img src="' + currentIcon.replace(/"/g, '&quot;') + '" onerror="this.onerror=null;this.parentNode.innerHTML=\'◈\'" alt=""></div><input type="text" id="iconInput" name="icon" value="' + (s.icon || '').replace(/"/g, '&quot;') + '" placeholder="https://example.com/icon.png (opsyonal)" oninput="updateIconPreview(this.value)"></div><div class="form-group"><label class="form-label">🔒 Access Type</label><select id="accessType" onchange="updateAccessUI()"><option value="public"' + (s.access_type === 'public' ? ' selected' : '') + '>🌐 Public</option><option value="whitelist"' + (s.access_type === 'whitelist' ? ' selected' : '') + '>🔒 Whitelist</option></select></div><div class="form-group" id="idListWrap" style="display:' + (s.access_type === 'whitelist' ? 'block' : 'none') + ';"><label class="form-label">👤 User IDs</label><div id="idList">' + idsHtml + '</div><button type="button" class="btn btn-success btn-sm" onclick="addIdRow()">+ Add User</button></div><input type="hidden" name="access_type" id="accessTypeHidden" value="' + s.access_type + '"><input type="hidden" name="allowed_ids" id="allowedIdsHidden" value="[]"><div class="form-group"><label class="form-label">📜 Lua Code</label><textarea name="content" required>' + escaped + '</textarea></div><button type="submit" class="btn btn-primary">💾 Save</button></form></div><script>function updateIconPreview(u){var p=document.getElementById("iconPreview");if(u&&u.trim()){p.innerHTML=\'<img src="\'+u.replace(/"/g,"&quot;")+\'" onerror="this.onerror=null;this.parentNode.innerHTML=\'◈\'" alt="">\'}else{p.innerHTML=\'<img src="' + FAVICON_DATA + '" alt="">\'}}function updateAccessUI(){document.getElementById("idListWrap").style.display=document.getElementById("accessType").value==="whitelist"?"block":"none"}function addIdRow(){var l=document.getElementById("idList");var d=document.createElement("div");d.className="id-row";d.innerHTML=\'<input type="text" class="id-input" placeholder="Roblox User ID" inputmode="numeric"><button type="button" onclick="removeIdRow(this)">×</button>\';l.appendChild(d)}function removeIdRow(b){b.parentNode.remove()}function prepareSubmit(){var s=document.getElementById("accessType");document.getElementById("accessTypeHidden").value=s.value;if(s.value==="whitelist"){var ids=[];document.querySelectorAll(".id-input").forEach(function(el){var v=el.value.trim();if(v&&/^[0-9]+$/.test(v))ids.push(v)});document.getElementById("allowedIdsHidden").value=JSON.stringify(ids)}else{document.getElementById("allowedIdsHidden").value="[]"}}</script>';
        res.send(renderLayout({ title: 'Edit', pageTitle: 'Edit Script', pageSubtitle: s.name, content: content, user: req.session.user, activeNav: 'dashboard' }));
    } catch (e) { res.status(500).send('Error'); }
});
app.post('/edit/:token', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (r.rows.length === 0) return res.status(404).send("Not found");
        const s = r.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied");
        let allowed_ids = req.body.allowed_ids || '[]';
        try { JSON.parse(allowed_ids); } catch(e) { allowed_ids = '[]'; }
        const icon = (req.body.icon || '').trim().substring(0, 2000);
        await pool.query('UPDATE scripts SET name=$1, version=$2, real_content=$3, access_type=$4, allowed_ids=$5, icon=$6 WHERE token=$7', [req.body.name, req.body.version || 'V1', req.body.content, req.body.access_type || 'public', allowed_ids, icon, req.params.token]);
        res.redirect('/');
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/delete/:token', requireLogin, async function(req, res) {
    try { const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]); if (r.rows.length === 0) return res.redirect('/'); const s = r.rows[0]; const isAdmin = req.session.user.role === 'ADMIN'; if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied"); await pool.query('DELETE FROM scripts WHERE token = $1', [req.params.token]); await pool.query('DELETE FROM execution_logs WHERE script_id = $1', [s.id]); res.redirect('/'); } catch (e) { res.status(500).send('Error'); }
});

// ==================== PRETTY URL LOADSTRING ====================
app.get('/:scriptName/:version/id=:shortId', async function(req, res) {
    try {
        const shortId = req.params.shortId;
        const r = await pool.query('SELECT * FROM scripts WHERE short_id = $1 LIMIT 1', [shortId]);
        if (r.rows.length === 0) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(404).send("-- Not found --"); }
        const s = r.rows[0];
        const accessType = s.access_type || 'public';

        if (accessType === 'public') {
            await pool.query('INSERT INTO execution_logs (script_id, user_id, username, allowed, kicked) VALUES ($1,$2,$3,$4,$5)', [s.id, 'public', '', true, false]);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(s.real_content);
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(buildWhitelistWrapper(s.short_id));
    } catch (e) { 
        console.error(e); 
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); 
        return res.status(500).send("-- Error --"); 
    }
});

// ==================== API/RAW (legacy) ====================
app.get('/api/raw', async function(req, res) {
    try {
        const shortId = req.query.id;
        if (!shortId) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(400).send("-- Invalid --"); }
        const r = await pool.query('SELECT * FROM scripts WHERE short_id = $1 LIMIT 1', [shortId]);
        if (r.rows.length === 0) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(404).send("-- Not found --"); }
        const s = r.rows[0];
        const accessType = s.access_type || 'public';

        if (accessType === 'public') {
            await pool.query('INSERT INTO execution_logs (script_id, user_id, username, allowed, kicked) VALUES ($1,$2,$3,$4,$5)', [s.id, 'public', '', true, false]);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(s.real_content);
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(buildWhitelistWrapper(s.short_id));
    } catch (e) { console.error(e); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.status(500).send("-- Error --"); }
});

// ==================== VERIFY ENDPOINT ====================
app.get('/api/verify', async function(req, res) {
    try {
        const shortId = req.query.id;
        const userId = req.query.userId;
        const username = req.query.username || '';
        if (!shortId || !userId) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.send("ACCESS_DENIED"); }

        const r = await pool.query('SELECT * FROM scripts WHERE short_id = $1 LIMIT 1', [shortId]);
        if (r.rows.length === 0) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.send("ACCESS_DENIED"); }
        const s = r.rows[0];

        let allowedIds = [];
        try { allowedIds = JSON.parse(s.allowed_ids || '[]'); } catch(e) { allowedIds = []; }
        allowedIds = allowedIds.map(x => String(x));

        if (allowedIds.length === 0) {
            await pool.query('INSERT INTO execution_logs (script_id, user_id, username, allowed, kicked) VALUES ($1,$2,$3,$4,$5)', [s.id, String(userId), String(username).substring(0,100), true, false]);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(s.real_content);
        }

        const isAllowed = allowedIds.includes(String(userId));
        await pool.query('INSERT INTO execution_logs (script_id, user_id, username, allowed, kicked) VALUES ($1,$2,$3,$4,$5)', [s.id, String(userId), String(username).substring(0,100), isAllowed, !isAllowed]);

        if (!isAllowed) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send("ACCESS_DENIED");
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(s.real_content);
    } catch (e) { console.error(e); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.send("ACCESS_DENIED"); }
});

// ==================== LOGS ====================
app.get('/logs/:token', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (r.rows.length === 0) return res.status(404).send('Not found');
        const s = r.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send('Denied');
        const logs = await pool.query('SELECT * FROM execution_logs WHERE script_id = $1 ORDER BY created_at DESC LIMIT 200', [s.id]);
        let total = logs.rows.length, allowedC = logs.rows.filter(l => l.allowed).length, kickedC = logs.rows.filter(l => l.kicked).length;
        const stats = '<div class="stat-grid"><div class="stat"><div class="stat-label">Total</div><div class="stat-value">' + total + '</div></div><div class="stat"><div class="stat-label">Allowed</div><div class="stat-value" style="color:#4ade80">' + allowedC + '</div></div><div class="stat"><div class="stat-label">Kicked</div><div class="stat-value" style="color:#ff5555">' + kickedC + '</div></div></div>';
        let rows = '';
        for (const l of logs.rows) {
            const cls = l.allowed ? 'allowed' : 'kicked';
            const icon = l.allowed ? '✓' : '✗';
            const badge = l.allowed ? '<span class="badge badge-green">Allowed</span>' : '<span class="badge badge-red">Kicked</span>';
            rows += '<div class="log-item log-' + cls + '"><div class="log-icon ' + cls + '">' + icon + '</div><div style="flex:1;"><div style="font-weight:700;">' + (l.username || 'Unknown') + ' <span style="font-family:monospace;font-size:11px;color:var(--text3);">(' + l.user_id + ')</span></div><div style="font-size:11px;color:var(--text3);">' + new Date(l.created_at).toLocaleString() + '</div></div>' + badge + '</div>';
        }
        res.send(renderLayout({ title: 'Logs', pageTitle: 'Execution Logs', pageSubtitle: s.name, content: stats + (rows || '<div class="empty"><div>No logs yet</div></div>'), user: req.session.user, activeNav: 'dashboard' }));
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== ADMIN ====================
app.get('/admin', requireLogin, requireAdmin, async function(req, res) {
    try {
        const u = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
        let rows = '';
        for (const x of u.rows) { const isA = x.role === 'ADMIN'; rows += '<div class="card" style="display:flex;align-items:center;gap:14px;"><div class="user-avatar ' + (isA ? 'user-avatar-admin' : '') + '">' + x.username[0] + '</div><div style="flex:1;"><div style="font-weight:700;">' + x.username + ' <span class="badge ' + (isA ? 'badge-admin' : 'badge-purple') + '">' + x.role + '</span></div></div></div>'; }
        res.send(renderLayout({ title: 'Admin', pageTitle: 'Admin Panel', pageSubtitle: u.rows.length + ' users', content: rows || '<div class="empty">No users</div>', user: req.session.user, activeNav: 'admin' }));
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== SERVERS ====================
app.get('/servers', requireLogin, async function(req, res) {
    const me = req.session.user.username;
    const r = await pool.query('SELECT s.*, (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count FROM servers s WHERE s.owner = $1 OR s.id IN (SELECT server_id FROM server_members WHERE username = $1) ORDER BY s.created_at DESC', [me]);
    let cards = '';
    for (const s of r.rows) {
        const isOwner = s.owner === me;
        const badge = isOwner ? '<span class="badge badge-yellow">👑 Owner</span>' : '<span class="badge badge-purple">Member</span>';
        cards += '<div class="card" style="cursor:pointer;" onclick="window.location.href=\'/server/' + s.id + '\'"><div style="display:flex;gap:14px;margin-bottom:14px;"><div style="width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;">' + (s.icon || '🎮') + '</div><div><div style="font-size:17px;font-weight:800;margin-bottom:6px;">' + s.name + '</div><div style="display:flex;gap:6px;">' + badge + '<span class="badge badge-purple">' + s.member_count + ' members</span></div></div></div><div class="copy-box" onclick="event.stopPropagation();copyText(\'' + s.invite_code + '\')">🔑 Invite: ' + s.invite_code + ' 📋</div></div>';
    }
    const content = (r.rows.length === 0 ? '<div class="empty"><div class="empty-icon">🏠</div><div style="font-size:18px;font-weight:700;margin-bottom:20px;">No servers yet</div></div>' : '<div class="grid-servers">' + cards + '</div>') + '<div style="margin-top:20px;display:flex;gap:10px;"><button class="btn btn-primary" onclick="document.getElementById(\'createServerModal\').style.display=\'flex\'">➕ Create Server</button><button class="btn btn-secondary" onclick="document.getElementById(\'joinServerModal\').style.display=\'flex\'">🔗 Join Server</button></div><div id="createServerModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;align-items:center;justify-content:center;padding:20px;"><div class="card" style="width:440px;"><div style="font-size:20px;font-weight:800;margin-bottom:18px;">Create Server</div><div class="form-group"><label class="form-label">Name</label><input type="text" id="newServerName"></div><div class="form-group"><label class="form-label">Icon</label><input type="text" id="newServerIcon" value="🎮" maxlength="2"></div><div style="display:flex;gap:10px;justify-content:flex-end;"><button class="btn btn-ghost" onclick="document.getElementById(\'createServerModal\').style.display=\'none\'">Cancel</button><button class="btn btn-primary" onclick="createServer()">Create</button></div></div></div><div id="joinServerModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;align-items:center;justify-content:center;padding:20px;"><div class="card" style="width:440px;"><div style="font-size:20px;font-weight:800;margin-bottom:18px;">Join Server</div><div class="form-group"><label class="form-label">Invite Code</label><input type="text" id="joinInviteCode"></div><div style="display:flex;gap:10px;justify-content:flex-end;"><button class="btn btn-ghost" onclick="document.getElementById(\'joinServerModal\').style.display=\'none\'">Cancel</button><button class="btn btn-primary" onclick="joinServer()">Join</button></div></div></div><script>async function createServer(){const n=document.getElementById("newServerName").value.trim();const i=document.getElementById("newServerIcon").value.trim()||"🎮";if(!n)return alert("Name required");const r=await fetch("/api/servers/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n,icon:i})});const d=await r.json();if(d.id)window.location.href="/server/"+d.id;else alert(d.error||"Error")}async function joinServer(){const c=document.getElementById("joinInviteCode").value.trim();if(!c)return alert("Code required");const r=await fetch("/api/servers/join",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({invite_code:c})});const d=await r.json();if(d.id)window.location.href="/server/"+d.id;else alert(d.error||"Invalid")}</script>';
    res.send(renderLayout({ title: 'Servers', pageTitle: 'Servers', pageSubtitle: 'Your Discord-style servers', content: content, user: req.session.user, activeNav: 'servers' }));
});

app.post('/api/servers/create', requireLogin, async function(req, res) {
    try {
        const { name, icon } = req.body;
        if (!name || name.length < 2) return res.status(400).json({ error: 'Name too short' });
        const invite = makeInvite();
        const r = await pool.query('INSERT INTO servers (name, owner, invite_code, icon) VALUES ($1,$2,$3,$4) RETURNING *', [name.substring(0, 100), req.session.user.username, invite, (icon || '🎮').substring(0, 2)]);
        const srv = r.rows[0];
        await pool.query('INSERT INTO server_members (server_id, username, role) VALUES ($1,$2,$3)', [srv.id, req.session.user.username, 'OWNER']);
        await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1,$2,$3,$4)', [srv.id, 'general', 'text', req.session.user.username]);
        res.json(srv);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/servers/join', requireLogin, async function(req, res) {
    try {
        const { invite_code } = req.body;
        const r = await pool.query('SELECT * FROM servers WHERE invite_code = $1', [invite_code]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Invalid code' });
        const srv = r.rows[0];
        const ex = await pool.query('SELECT * FROM server_members WHERE server_id = $1 AND username = $2', [srv.id, req.session.user.username]);
        if (ex.rows.length === 0) await pool.query('INSERT INTO server_members (server_id, username) VALUES ($1,$2)', [srv.id, req.session.user.username]);
        res.json(srv);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== SERVER VIEW ====================
app.get('/server/:id', requireLogin, async function(req, res) {
    try {
        const serverId = parseInt(req.params.id);
        const me = req.session.user.username;
        const srvR = await pool.query('SELECT * FROM servers WHERE id = $1', [serverId]);
        if (srvR.rows.length === 0) return res.status(404).send('Not found');
        const srv = srvR.rows[0];
        const isOwner = srv.owner === me;
        const isGlobalAdmin = req.session.user.role === 'ADMIN';
        const memberChk = await pool.query('SELECT * FROM server_members WHERE server_id = $1 AND username = $2', [serverId, me]);
        if (memberChk.rows.length === 0 && !isOwner && !isGlobalAdmin) return res.redirect('/servers');
        const channelsR = await pool.query('SELECT * FROM channels WHERE server_id = $1 ORDER BY type DESC, name ASC', [serverId]);
        const channels = channelsR.rows;
        const membersR = await pool.query('SELECT * FROM server_members WHERE server_id = $1 ORDER BY role ASC, username ASC', [serverId]);
        const canManage = isOwner || isGlobalAdmin;

        let chHtml = '';
        for (const c of channels) {
            const icon = c.type === 'text' ? '#' : '🔊';
            const del = canManage ? '<button class="channel-delete" onclick="event.stopPropagation();deleteChannel(' + c.id + ')">🗑</button>' : '';
            chHtml += '<div class="channel-item" data-channel-id="' + c.id + '" data-channel-name="' + c.name + '" data-channel-type="' + c.type + '" onclick="switchChannel(' + c.id + ', \'' + c.name.replace(/'/g, "\\'") + '\', \'' + c.type + '\')"><div class="channel-item-left"><span style="color:var(--text3);">' + icon + '</span><span class="channel-name">' + c.name + '</span></div>' + del + '</div>';
        }
        let mbHtml = '';
        for (const m of membersR.rows) {
            const bdg = m.role === 'OWNER' ? '👑' : '';
            mbHtml += '<div class="member-item"><div class="member-avatar">' + m.username[0].toUpperCase() + '</div><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + m.username + '</span><span style="font-size:11px;">' + bdg + '</span></div>';
        }
        const content = '<div class="chat-layout"><div class="chat-sidebar"><div class="chat-sidebar-header"><div style="display:flex;align-items:center;gap:10px;"><span style="font-size:22px;">' + (srv.icon || '🎮') + '</span><span style="font-weight:800;font-size:14px;">' + srv.name + '</span></div></div><div class="channel-group-label"><span>CHANNELS</span>' + (canManage ? '<button onclick="document.getElementById(\'createChannelModal\').style.display=\'flex\'" style="color:var(--text3);font-size:16px;">+</button>' : '') + '</div><div id="channelsList">' + chHtml + '</div><div style="margin-top:auto;padding:12px;border-top:1px solid var(--border);"><div class="copy-box" onclick="copyText(\'' + srv.invite_code + '\')">🔑 ' + srv.invite_code + ' 📋</div><a href="/servers" style="display:block;text-align:center;color:var(--text2);font-size:12px;padding:8px;">← All Servers</a></div></div><div class="chat-main"><div class="chat-header"><div style="display:flex;align-items:center;gap:8px;"><span id="currentChannelIcon" style="color:var(--text3);">#</span><span id="currentChannelName" style="font-weight:700;">Select channel</span></div></div><div class="chat-messages" id="chatMessages"><div style="text-align:center;color:var(--text3);padding:40px;">Select a channel</div></div><div class="chat-input-area"><form onsubmit="event.preventDefault();sendMessage();"><input type="text" id="chatInput" placeholder="Message..." maxlength="500"><button type="submit" class="btn btn-primary">➤</button></form></div></div><div class="members-list"><div style="font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;padding:8px;">Members (' + membersR.rows.length + ')</div>' + mbHtml + '</div></div><div id="createChannelModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;align-items:center;justify-content:center;"><div class="card" style="width:400px;"><div style="font-size:18px;font-weight:800;margin-bottom:16px;">Create Channel</div><div class="form-group"><label class="form-label">Name</label><input type="text" id="newChannelName"></div><div class="form-group"><label class="form-label">Type</label><select id="newChannelType"><option value="text">💬 Text</option><option value="voice">🔊 Voice</option></select></div><div style="display:flex;gap:10px;justify-content:flex-end;"><button class="btn btn-ghost" onclick="document.getElementById(\'createChannelModal\').style.display=\'none\'">Cancel</button><button class="btn btn-primary" onclick="createChannel()">Create</button></div></div></div><script>const SERVER_ID=' + serverId + ';let currentChannelId=null,currentChannelType="text";async function createChannel(){const n=document.getElementById("newChannelName").value.trim();const t=document.getElementById("newChannelType").value;if(!n)return alert("Name required");const r=await fetch("/api/servers/' + serverId + '/channels",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n,type:t})});const d=await r.json();if(d.id){location.reload()}else alert(d.error||"Error")}async function deleteChannel(id){if(!confirm("Delete this channel?"))return;const r=await fetch("/api/channels/"+id+"/delete",{method:"POST"});const d=await r.json();if(d.success){const el=document.querySelector(\'.channel-item[data-channel-id="\'+id+\'"]\');if(el)el.remove();if(currentChannelId===id){currentChannelId=null;document.getElementById("chatMessages").innerHTML=\'<div style="text-align:center;color:var(--text3);padding:40px;">Select a channel</div>\';document.getElementById("currentChannelName").textContent="Select channel"}}else alert(d.error||"Error")}async function switchChannel(id,name,type){currentChannelId=id;currentChannelType=type;document.querySelectorAll(".channel-item").forEach(function(el){el.classList.remove("active")});const el=document.querySelector(\'.channel-item[data-channel-id="\'+id+\'"]\');if(el)el.classList.add("active");document.getElementById("currentChannelName").textContent=name;document.getElementById("currentChannelIcon").textContent=type==="voice"?"🔊":"#";document.getElementById("chatMessages").innerHTML=\'<div style="text-align:center;color:var(--text3);padding:20px;">Loading...</div>\';const r=await fetch("/api/channels/"+id+"/messages");const msgs=await r.json();renderMessages(msgs)}function renderMessages(msgs){const box=document.getElementById("chatMessages");if(msgs.length===0){box.innerHTML=\'<div style="text-align:center;color:var(--text3);padding:40px;">No messages yet</div>\';return}box.innerHTML="";msgs.forEach(function(m){const isA=m.role==="ADMIN";const av=isA?"linear-gradient(135deg,#ffaa00,#ff6600)":"linear-gradient(135deg,var(--red),var(--red2))";const div=document.createElement("div");div.className="chat-message";div.innerHTML=\'<div class="msg-avatar" style="background:\'+av+\'">\'+m.username[0].toUpperCase()+\'</div><div class="msg-body"><div class="msg-meta"><span class="msg-username">\'+m.username+\'</span>\'+(isA?\'<span class="badge badge-admin">Admin</span>\':"")+\'<span class="msg-time">\'+m.created_at+\'</span></div><div class="msg-content">\'+m.message+\'</div></div>\';box.appendChild(div)});box.scrollTop=box.scrollHeight}async function sendMessage(){if(!currentChannelId||currentChannelType==="voice")return;const input=document.getElementById("chatInput");const msg=input.value.trim();if(!msg)return;await fetch("/api/channels/"+currentChannelId+"/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});input.value="";switchChannel(currentChannelId,document.getElementById("currentChannelName").textContent,currentChannelType)}setInterval(function(){if(currentChannelId&&currentChannelType==="text")switchChannel(currentChannelId,document.getElementById("currentChannelName").textContent,currentChannelType)},5000);</script>';
        res.send(renderLayout({ title: srv.name, pageTitle: srv.name, pageSubtitle: membersR.rows.length + ' members', content: content, user: req.session.user, activeNav: 'servers' }));
    } catch (e) { console.error(e); res.status(500).send('Error: ' + e.message); }
});

app.post('/api/servers/:id/channels', requireLogin, async function(req, res) {
    try {
        const serverId = parseInt(req.params.id);
        const me = req.session.user.username;
        const isAdmin = req.session.user.role === 'ADMIN';
        const srvR = await pool.query('SELECT * FROM servers WHERE id = $1', [serverId]);
        if (srvR.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const srv = srvR.rows[0];
        if (srv.owner !== me && !isAdmin) return res.status(403).json({ error: 'Only owner' });
        const { name, type } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        const cleanName = name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-').substring(0, 30);
        const chk = await pool.query('SELECT * FROM channels WHERE server_id = $1 AND name = $2', [serverId, cleanName]);
        if (chk.rows.length > 0) return res.status(400).json({ error: 'Exists' });
        const r = await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [serverId, cleanName, type === 'voice' ? 'voice' : 'text', me]);
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/channels/:id/delete', requireLogin, async function(req, res) {
    try {
        const cid = parseInt(req.params.id);
        const me = req.session.user.username;
        const isAdmin = req.session.user.role === 'ADMIN';
        const cR = await pool.query('SELECT c.*, s.owner FROM channels c JOIN servers s ON c.server_id = s.id WHERE c.id = $1', [cid]);
        if (cR.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const c = cR.rows[0];
        if (c.owner !== me && !isAdmin) return res.status(403).json({ error: 'Only owner' });
        await pool.query('DELETE FROM chat_messages WHERE channel_id = $1', [cid]);
        await pool.query('DELETE FROM channels WHERE id = $1', [cid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/channels/:id/messages', requireLogin, async function(req, res) {
    try {
        const cid = parseInt(req.params.id);
        const msgs = await pool.query('SELECT * FROM chat_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 100', [cid]);
        res.json(msgs.rows.reverse().map(m => ({ username: m.username, role: m.role, message: m.message, created_at: new Date(m.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/channels/:id/send', requireLogin, async function(req, res) {
    try {
        const cid = parseInt(req.params.id);
        const msg = (req.body.message || '').trim().substring(0, 500);
        if (!msg) return res.status(400).json({ error: 'Empty' });
        await pool.query('INSERT INTO chat_messages (channel_id, username, role, message) VALUES ($1,$2,$3,$4)', [cid, req.session.user.username, req.session.user.role, msg]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== START ====================
server.listen(PORT, function() {
    console.log('✅ ' + BRAND_NAME + ' — ShieldHub v3.0');
    console.log('🔒 Public = Lahat pwede | Whitelist = Auto-Kick kung wala');
    console.log('🔗 Pretty URL: /:name/:version/id=:shortId');
    console.log('🖼️ Custom Icon support + Favicon SVG');
});
