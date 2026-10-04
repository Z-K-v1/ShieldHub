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

// ==================== DATABASE INIT ====================
async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role VARCHAR(20) DEFAULT 'USER', display_name VARCHAR(50), tag VARCHAR(4), bio VARCHAR(200) DEFAULT '', created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS scripts (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(100) NOT NULL DEFAULT 'Script', version VARCHAR(50) NOT NULL DEFAULT 'V1', real_content TEXT NOT NULL, public_content TEXT NOT NULL, token VARCHAR(64) UNIQUE NOT NULL, owner VARCHAR(50) NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS "session" ("sid" VARCHAR NOT NULL COLLATE "default", "sess" JSON NOT NULL, "expire" TIMESTAMP(6) NOT NULL, CONSTRAINT "session_pkey" PRIMARY KEY ("sid"));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS servers (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, owner VARCHAR(50) NOT NULL, invite_code VARCHAR(16) UNIQUE NOT NULL, icon VARCHAR(10) DEFAULT '🎮', created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS server_members (id SERIAL PRIMARY KEY, server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE, username VARCHAR(50) NOT NULL, role VARCHAR(20) DEFAULT 'MEMBER', joined_at TIMESTAMP DEFAULT NOW(), UNIQUE(server_id, username));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS channels (id SERIAL PRIMARY KEY, name VARCHAR(50) NOT NULL, description VARCHAR(200) DEFAULT '', created_by VARCHAR(50) NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE, username VARCHAR(50) NOT NULL, role VARCHAR(20) DEFAULT 'USER', message TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS friends (id SERIAL PRIMARY KEY, user1 VARCHAR(50) NOT NULL, user2 VARCHAR(50) NOT NULL, status VARCHAR(20) DEFAULT 'pending', requested_by VARCHAR(50) NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user1, user2));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS dm_messages (id SERIAL PRIMARY KEY, from_user VARCHAR(50) NOT NULL, to_user VARCHAR(50) NOT NULL, message TEXT NOT NULL, read BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW());`);

        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(50);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tag VARCHAR(4);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200) DEFAULT '';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS slug VARCHAR(100) DEFAULT 'Script';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS version VARCHAR(50) DEFAULT 'V1';`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS type VARCHAR(10) DEFAULT 'text';`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) DEFAULT 'public';`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS allowed_users TEXT DEFAULT '';`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS read_only BOOLEAN DEFAULT FALSE;`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS owner_only BOOLEAN DEFAULT FALSE;`);
        await pool.query(`UPDATE scripts SET slug = LOWER(REPLACE(name, ' ', '_')) WHERE slug = 'Script' OR slug IS NULL;`);
        await pool.query(`UPDATE scripts SET version = 'V1' WHERE version IS NULL;`);

        try { await pool.query(`ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_name_key;`); } catch(e) {}

        const noTag = await pool.query(`SELECT id FROM users WHERE tag IS NULL`);
        for (const u of noTag.rows) {
            const tag = Math.floor(1000 + Math.random() * 9000).toString();
            await pool.query(`UPDATE users SET tag = $1, display_name = username WHERE id = $2`, [tag, u.id]);
        }

        const srvCheck = await pool.query('SELECT * FROM servers LIMIT 1');
        let defaultServerId = null;
        if (srvCheck.rows.length === 0) {
            const invite = crypto.randomBytes(6).toString('hex');
            const r = await pool.query('INSERT INTO servers (name, owner, invite_code, icon) VALUES ($1, $2, $3, $4) RETURNING *', ['Zyrox-Kido', 'system', invite, '⭐']);
            defaultServerId = r.rows[0].id;
        } else defaultServerId = srvCheck.rows[0].id;

        const chanCheck = await pool.query('SELECT * FROM channels WHERE server_id = $1', [defaultServerId]);
        if (chanCheck.rows.length === 0) {
            await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4)', [defaultServerId, 'general', 'text', 'system']);
            await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4)', [defaultServerId, 'Lounge', 'voice', 'system']);
        }
        await pool.query(`UPDATE channels SET server_id = $1 WHERE server_id IS NULL`, [defaultServerId]);

        console.log('✅ DB ready');
        const adminPass = process.env.ADMIN_PASSWORD;
        if (adminPass) {
            const ex = await pool.query('SELECT * FROM users WHERE username = $1', ['Z-K']);
            if (ex.rows.length === 0) {
                const tag = Math.floor(1000 + Math.random() * 9000).toString();
                await pool.query('INSERT INTO users (username, password, role, display_name, tag) VALUES ($1, $2, $3, $4, $5)', ['Z-K', adminPass, 'ADMIN', 'Z-K', tag]);
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

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#ff3b3b"/><stop offset="100%" style="stop-color:#cc0000"/></linearGradient></defs><path d="M50 5 L85 20 L85 50 C85 75 70 90 50 95 C30 90 15 75 15 50 L15 20 Z" fill="url(#g)" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/><text x="50" y="62" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#fff" text-anchor="middle">ZK</text></svg>';
app.get('/logo.svg', (req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.send(LOGO_SVG); });
app.get('/favicon.svg', (req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.send(LOGO_SVG); });
app.get('/favicon.ico', (req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.send(LOGO_SVG); });

// ==================== OBFUSCATION ====================
function obfuscateScript(code) {
    const encoded = Buffer.from(code, 'utf8').toString('base64');
    return 'local _b64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"\n' +
        'local _d="' + encoded + '"\n' +
        'local _o={}\n' +
        'for _c in _d:gmatch(".") do local _n=_b64:find(_c,1,true) if _n then _o[#_o+1]=_n-1 end end\n' +
        'local _r=""\n' +
        'for _i=1,#_o,4 do\n' +
        'local _a=_o[_i] or 0\n' +
        'local _b=_o[_i+1] or 0\n' +
        'local _c=_o[_i+2] or 0\n' +
        'local _d2=_o[_i+3] or 0\n' +
        'local _n=_a*262144+_b*4096+_c*64+_d2\n' +
        '_r=_r..string.char(math.floor(_n/65536)%256)\n' +
        'if _c then _r=_r..string.char(math.floor(_n/256)%256) end\n' +
        'if _d2 then _r=_r..string.char(_n%256) end\n' +
        'end\n' +
        'local _f=loadstring(_r)\n' +
        'if _f then _f() end';
}
function makeSlug(name) { return name.toString().trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50) || 'Script'; }
function versionDropdown(sv) { let o = ''; for (let i = 1; i <= 1000; i++) { const v = 'V' + i; o += '<option value="' + v + '" ' + (v === sv ? 'selected' : '') + '>' + v + '</option>'; } return o; }
function getHtmlHead(t) { return '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"><meta name="theme-color" content="#0a0505"><title>' + t + ' · ' + BRAND_SHORT + '</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">'; }

const LAYOUT_STYLES = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg-0:#0a0505;--bg-1:#0f0808;--bg-2:#150a0a;--bg-3:#1c0d0d;--border-0:#2a1414;--border-1:#3a1a1a;--border-2:#4d2020;--text-0:#fff;--text-1:#d4d4d4;--text-2:#8a8a8a;--text-3:#5a5a5a;--accent:#ff3b3b;--accent-bright:#ff5555;--accent-dim:rgba(255,59,59,0.1);--accent-glow:rgba(255,59,59,0.5);--red-1:#ff3b3b;--red-2:#cc0000}
html,body{height:100%}
body{font-family:'Inter',sans-serif;background:var(--bg-0);color:var(--text-0);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;overflow-x:hidden;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 900px 700px at 15% -10%,rgba(255,59,59,0.15) 0%,transparent 55%),radial-gradient(ellipse 900px 700px at 85% 110%,rgba(184,85,255,0.08) 0%,transparent 55%);pointer-events:none;z-index:0}
a{color:inherit;text-decoration:none}button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}input,textarea,select,button{-webkit-appearance:none;appearance:none}
.layout{display:flex;min-height:100vh;position:relative;z-index:1}
.sidebar{width:264px;background:rgba(15,8,8,0.7);backdrop-filter:blur(20px);border-right:1px solid var(--border-0);padding:20px 14px;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50;transition:transform 0.35s cubic-bezier(0.4,0,0.2,1)}
.sidebar-brand{display:flex;align-items:center;gap:11px;padding:6px 10px 18px 10px;border-bottom:1px solid var(--border-0);margin-bottom:16px}
.sidebar-logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px;color:#fff}
.sidebar-brand-text{display:flex;flex-direction:column;min-width:0}
.sidebar-brand-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px}
.sidebar-brand-sub{font-size:10px;color:var(--text-3);font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-top:2px}
.sidebar-nav{display:flex;flex-direction:column;gap:2px;flex:1;overflow-y:auto}
.nav-section-label{font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:1.2px;padding:14px 12px 6px 12px}
.nav-item{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:10px;font-size:14px;font-weight:600;color:var(--text-1);transition:all 0.2s;cursor:pointer;position:relative;min-height:44px}
.nav-item:hover{background:var(--bg-2);color:var(--text-0)}
.nav-item.active{background:var(--accent-dim);color:var(--accent)}
.nav-item.active::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:22px;background:linear-gradient(180deg,var(--red-1),var(--red-2));border-radius:0 4px 4px 0}
.nav-icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.sidebar-footer{padding-top:14px;border-top:1px solid var(--border-0)}
.user-card{display:flex;align-items:center;gap:10px;padding:10px;border-radius:11px;background:var(--bg-2);border:1px solid transparent;min-height:52px}
.user-avatar{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex-shrink:0}
.user-avatar-admin{background:linear-gradient(135deg,#ffaa00,#ff6600)}
.user-meta{display:flex;flex-direction:column;min-width:0;flex:1}
.user-name{font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-role{font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:0.6px}
.main{flex:1;margin-left:264px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:64px;background:rgba(10,5,5,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border-0);padding:0 28px;display:flex;align-items:center;justify-content:space-between;gap:20px;position:sticky;top:0;z-index:40}
.topbar-left{display:flex;align-items:center;gap:14px;min-width:0;flex:1}
.topbar-title{font-size:15px;font-weight:700;font-family:'Space Grotesk',sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-right{display:flex;align-items:center;gap:8px}
.icon-btn{width:40px;height:40px;border-radius:11px;background:var(--bg-2);border:1px solid var(--border-0);display:flex;align-items:center;justify-content:center;color:var(--text-1);font-size:15px}
.icon-btn:hover{background:var(--bg-3);color:var(--accent)}
.content{padding:32px;flex:1;max-width:1440px;width:100%;margin:0 auto}
.page-header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:32px}
.page-title{font-family:'Space Grotesk',sans-serif;font-size:32px;font-weight:700;letter-spacing:-1.2px;margin-bottom:6px;line-height:1.1;background:linear-gradient(135deg,#fff 0%,#ff5555 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.page-subtitle{font-size:13.5px;color:var(--text-2);font-weight:500}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:11px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;border:1px solid transparent;min-height:42px;transition:all 0.2s;text-decoration:none;font-family:inherit}
.btn-primary{background:linear-gradient(135deg,var(--red-1),var(--red-2));color:#fff;box-shadow:0 4px 20px rgba(255,59,59,0.3)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(255,59,59,0.5)}
.btn-secondary{background:var(--bg-2);color:var(--text-0);border-color:var(--border-1)}
.btn-secondary:hover{background:var(--bg-3)}
.btn-danger{background:rgba(255,59,59,0.08);color:#ff5555;border-color:rgba(255,59,59,0.2)}
.btn-danger:hover{background:rgba(255,59,59,0.15)}
.btn-ghost{background:transparent;color:var(--text-1);border-color:var(--border-1)}
.btn-ghost:hover{background:var(--bg-2);color:var(--text-0)}
.btn-sm{padding:9px 14px;font-size:12.5px;border-radius:9px;min-height:38px}
.card{position:relative;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:16px;padding:30px}
.form-group{margin-bottom:20px}
.form-label{display:block;font-size:12px;font-weight:700;color:var(--text-1);margin-bottom:9px;text-transform:uppercase}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
input,textarea,select{width:100%;padding:13px 15px;background:var(--bg-0);border:1px solid var(--border-0);border-radius:11px;color:var(--text-0);font-size:15px;font-family:inherit;outline:none;min-height:48px}
input:focus,textarea:focus,select:focus{border-color:var(--accent);background:var(--bg-1);box-shadow:0 0 0 3px var(--accent-dim)}
textarea{font-family:'JetBrains Mono',monospace;font-size:12.5px;resize:vertical;min-height:300px}
.empty{background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px dashed var(--border-1);border-radius:16px;padding:70px 30px;text-align:center}
.empty-icon{width:76px;height:76px;border-radius:20px;background:var(--bg-2);border:1px solid var(--border-0);display:flex;align-items:center;justify-content:center;font-size:34px;margin:0 auto 20px}
.empty-title{font-size:18px;font-weight:700;margin-bottom:8px}
.empty-desc{font-size:13.5px;color:var(--text-2);margin-bottom:24px}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:7px;font-size:10px;font-weight:800;border:1px solid transparent}
.badge-version{background:rgba(184,85,255,0.12);color:#c490ff;border-color:rgba(184,85,255,0.25)}
.badge-admin{background:rgba(255,170,0,0.12);color:#ffbb44;border-color:rgba(255,170,0,0.25)}
.badge-user{background:var(--accent-dim);color:var(--accent-bright);border-color:rgba(255,59,59,0.25)}
.badge-owner{background:rgba(74,158,255,0.12);color:#7cc0ff;border-color:rgba(74,158,255,0.25)}
.badge-private{background:rgba(255,59,59,0.15);color:#ff8888;border-color:rgba(255,59,59,0.3)}
.badge-personal{background:rgba(184,85,255,0.15);color:#c490ff;border-color:rgba(184,85,255,0.3)}
@keyframes toastIn{from{transform:translateX(400px) scale(0.9);opacity:0}to{transform:translateX(0) scale(1);opacity:1}}
@keyframes toastOut{to{transform:translateX(400px) scale(0.9);opacity:0}}
.toast{position:fixed;bottom:24px;right:24px;background:var(--bg-2);border:1px solid var(--border-1);color:var(--text-0);padding:14px 20px;border-radius:12px;font-weight:600;font-size:13.5px;box-shadow:0 24px 60px rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;gap:12px;animation:toastIn 0.35s}
.toast.hiding{animation:toastOut 0.3s forwards}
.toast::before{content:'';width:10px;height:10px;border-radius:50%}
.toast.success::before{background:var(--red-1);box-shadow:0 0 16px var(--accent-glow)}
.toast.error::before{background:#ffb800}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{position:relative;background:rgba(15,8,8,0.7);backdrop-filter:blur(30px);border:1px solid var(--border-1);border-radius:22px;padding:44px 40px;width:420px;max-width:100%;box-shadow:0 40px 100px rgba(0,0,0,0.7)}
.login-brand{display:flex;flex-direction:column;align-items:center;margin-bottom:32px;text-align:center}
.login-logo{width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:28px;color:#fff;margin-bottom:18px}
.login-title{font-family:'Space Grotesk',sans-serif;font-size:26px;font-weight:700;margin-bottom:6px}
.login-sub{font-size:13.5px;color:var(--text-2)}
.login-card input{margin-bottom:13px;padding:14px 16px}
.login-card .btn-primary{width:100%;padding:15px;font-size:14.5px;margin-top:8px}
.login-msg{margin-top:16px;text-align:center;font-size:12.5px;font-weight:600;min-height:18px}
.login-msg.error{color:#ff5555}
.login-msg.success{color:#22c55e}
.login-link{display:block;text-align:center;margin-top:22px;font-size:13.5px;color:var(--red-1);font-weight:700}
.menu-btn{display:none;width:42px;height:42px;border-radius:11px;background:var(--bg-2);border:1px solid var(--border-0);align-items:center;justify-content:center;color:var(--text-1);font-size:18px}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);z-index:45}
.overlay.active{display:block}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border-1);border-radius:5px}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
.modal-card{background:var(--bg-1);border:1px solid var(--border-1);border-radius:18px;width:460px;max-width:100%;box-shadow:0 40px 100px rgba(0,0,0,0.8)}
.modal-header{padding:20px 24px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between}
.modal-close{width:32px;height:32px;border-radius:8px;color:var(--text-2);font-size:22px;display:flex;align-items:center;justify-content:center}
.modal-close:hover{background:var(--bg-2);color:var(--text-0)}
.modal-body{padding:22px 24px}
.modal-footer{padding:16px 24px;border-top:1px solid var(--border-0);display:flex;gap:10px;justify-content:flex-end}
.chat-layout{display:grid;grid-template-columns:240px 1fr 200px;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:16px;overflow:hidden;height:calc(100vh - 220px);min-height:500px;position:relative}
.chat-sidebar{background:var(--bg-0);border-right:1px solid var(--border-0);display:flex;flex-direction:column}
.chat-sidebar-header{padding:16px 18px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between}
.chat-channels-list{flex:1;overflow-y:auto;padding:10px 8px}
.channel-group-label{font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:1px;padding:8px 12px 6px 12px;display:flex;justify-content:space-between;align-items:center}
.channel-group-label button{background:none;border:none;color:var(--text-3);font-size:16px;cursor:pointer;padding:0 4px}
.channel-item{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;cursor:pointer;color:var(--text-2);font-size:13.5px;font-weight:600;margin-bottom:2px;position:relative}
.channel-item:hover{background:var(--bg-2);color:var(--text-0)}
.channel-item.active{background:var(--accent-dim);color:var(--accent)}
.channel-hash{color:var(--text-3);font-size:16px;font-weight:700}
.channel-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.channel-icons{display:flex;gap:2px;opacity:0;transition:opacity 0.2s}
.channel-item:hover .channel-icons{opacity:1}
.channel-icon-btn{width:22px;height:22px;border-radius:5px;color:var(--text-3);font-size:12px;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:none}
.channel-icon-btn:hover{color:var(--accent);background:var(--bg-3)}
.voice-channel-item{display:flex;flex-direction:column;gap:6px;padding:9px 12px;background:var(--bg-2);border-radius:10px;margin-bottom:6px}
.voice-item-header{display:flex;align-items:center;gap:8px;padding:4px 0}
.voice-name{flex:1;font-size:13px;font-weight:600;color:var(--text-1)}
.voice-count{background:var(--accent);color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px}
.voice-join-btn{background:var(--accent-dim);border:1px solid rgba(255,59,59,0.3);color:var(--accent);padding:6px 12px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit}
.voice-join-btn:hover{background:var(--accent);color:#fff}
.voice-participants{display:flex;flex-direction:column;gap:3px}
.voice-user{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2);font-weight:600;padding:3px 4px;border-radius:6px}
.voice-user:hover{background:var(--bg-3)}
.voice-user-avatar{width:18px;height:18px;border-radius:6px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:800;flex-shrink:0}
.chat-sidebar-footer{padding:12px;border-top:1px solid var(--border-0)}
.chat-main{display:flex;flex-direction:column;min-width:0}
.chat-header{padding:16px 24px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between;background:var(--bg-0)}
.chat-mobile-toggle{display:none;background:var(--bg-2);border:1px solid var(--border-0);color:var(--text-1);font-size:16px;width:32px;height:32px;border-radius:8px;cursor:pointer;align-items:center;justify-content:center;margin-right:4px}
.chat-messages{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}
.chat-message{display:flex;gap:12px;align-items:flex-start}
.msg-avatar{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;flex-shrink:0}
.msg-body{flex:1;min-width:0}
.msg-meta{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.msg-username{font-weight:700;font-size:13.5px}
.msg-time{font-size:11px;color:var(--text-3);font-weight:600}
.msg-content{font-size:14px;line-height:1.55;word-wrap:break-word}
.msg-delete{background:none;border:none;color:var(--text-3);font-size:10.5px;cursor:pointer;margin-top:6px;padding:0;font-weight:600}
.chat-input-area{padding:16px 20px;border-top:1px solid var(--border-0);background:var(--bg-0)}
.chat-input-area form{display:flex;gap:10px;align-items:center}
.chat-input-area input{flex:1;margin:0;background:var(--bg-2);border-color:transparent}

.voice-panel{position:fixed;bottom:24px;right:24px;width:420px;max-width:calc(100vw - 32px);background:rgba(15,8,8,0.95);backdrop-filter:blur(30px);border:1px solid var(--border-1);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,0.7);z-index:9998;display:flex;flex-direction:column;overflow:hidden;transition:all 0.3s}
.voice-panel.fullscreen{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:100vw!important;border-radius:0!important;z-index:10000!important;bottom:0!important;right:0!important}
.voice-panel-header{padding:12px 16px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between}
.voice-panel.fullscreen .voice-panel-header{padding:16px 24px!important;background:rgba(0,0,0,0.5)!important}
.voice-live-dot{width:8px;height:8px;border-radius:50%;background:var(--red-1);box-shadow:0 0 12px var(--accent-glow);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.voice-min-btn{width:28px;height:28px;border-radius:6px;color:var(--text-2);font-size:16px;background:var(--bg-2);border:1px solid var(--border-0);cursor:pointer;display:flex;align-items:center;justify-content:center}
.voice-min-btn:hover{color:var(--accent);background:var(--bg-3)}
.voice-panel.fullscreen #voicePanelName{font-size:18px!important;font-weight:800!important}

.voice-body{padding:12px;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 160px);overflow-y:auto}
.voice-panel:not(.fullscreen) .voice-body{max-height:420px}
.voice-main-view{position:relative;background:#000;border-radius:12px;overflow:hidden;aspect-ratio:16/9;border:1px solid var(--border-0);width:100%;display:flex;align-items:center;justify-content:center}
.voice-panel.fullscreen .voice-main-view{max-height:70vh}
.voice-main-view video{width:100%;height:100%;object-fit:cover;display:block;transform:scaleX(-1)}
.voice-main-view video.screen-mode{object-fit:contain;transform:none;background:#000}
.voice-main-avatar{position:absolute;inset:0;background:linear-gradient(135deg,#2a1414,#1a0808);display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px}
.voice-main-avatar.show{display:flex}
.voice-main-avatar-circle{width:90px;height:90px;border-radius:50%;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:38px;color:#fff;border:4px solid rgba(255,255,255,0.1)}
.voice-main-avatar-name{font-size:16px;font-weight:700;color:#fff}
.voice-main-avatar-status{font-size:12px;color:var(--text-2);font-weight:600}
.voice-main-label{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.8);color:#fff;font-size:11px;font-weight:800;padding:5px 11px;border-radius:8px;display:flex;align-items:center;gap:6px;backdrop-filter:blur(8px)}
.voice-main-label.live::before{content:'';width:7px;height:7px;border-radius:50%;background:#23a55a;animation:pulse 1.2s infinite}
.voice-main-back{position:absolute;top:10px;right:10px;background:rgba(255,59,59,0.9);color:#fff;font-size:11px;font-weight:800;padding:6px 12px;border-radius:8px;cursor:pointer;border:none;font-family:inherit;display:none;align-items:center;gap:5px;backdrop-filter:blur(8px)}
.voice-main-back.show{display:flex}
.voice-main-back:hover{background:rgba(220,38,38,1)}

.voice-participants-strip{display:flex;gap:8px;overflow-x:auto;padding:4px 2px 6px 2px;min-height:70px;scrollbar-width:thin}
.voice-tile{position:relative;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:1;border:2px solid var(--border-0);min-width:80px;max-width:100px;width:100px;cursor:pointer;transition:all 0.15s;flex-shrink:0}
.voice-tile:hover{transform:translateY(-3px);border-color:var(--accent-glow);box-shadow:0 4px 16px rgba(255,59,59,0.3)}
.voice-tile.active-focus{border-color:var(--red-1);box-shadow:0 0 0 3px var(--accent-glow)}
.voice-tile.active-focus::after{content:'👁';position:absolute;top:3px;left:3px;background:var(--red-1);color:#fff;font-size:10px;width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center}
.voice-tile video{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.voice-tile-avatar{position:absolute;inset:0;background:linear-gradient(135deg,#2a1414,#1a0808);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:26px;color:#fff;font-family:'Space Grotesk',sans-serif}
.voice-tile-label{position:absolute;bottom:3px;left:3px;right:3px;background:rgba(0,0,0,0.8);color:#fff;font-size:9px;font-weight:700;padding:3px 5px;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
.voice-tile-muted-badge{position:absolute;top:3px;right:3px;background:rgba(220,38,38,0.95);color:#fff;font-size:10px;font-weight:800;padding:2px 5px;border-radius:5px}
.voice-tile-stream-badge{position:absolute;top:3px;right:3px;background:rgba(255,59,59,0.95);color:#fff;font-size:8px;font-weight:800;padding:2px 5px;border-radius:5px;text-transform:uppercase;letter-spacing:0.5px;animation:pulse 1.2s infinite}
.voice-tile-self-badge{position:absolute;bottom:3px;right:3px;background:rgba(74,158,255,0.9);color:#fff;font-size:8px;font-weight:800;padding:2px 5px;border-radius:5px}
.voice-tile-kick{position:absolute;top:3px;right:3px;background:rgba(0,0,0,0.8);color:#fff;font-size:11px;width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;font-family:inherit;z-index:3;opacity:0;transition:opacity 0.15s}
.voice-tile:hover .voice-tile-kick{opacity:1}
.voice-tile-kick:hover{background:rgba(220,38,38,0.95)}

.voice-controls{padding:12px 16px;border-top:1px solid var(--border-0);display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.voice-ctrl-btn{width:46px;height:46px;border-radius:12px;background:var(--bg-2);border:1px solid var(--border-0);color:var(--text-0);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s}
.voice-ctrl-btn:hover{background:var(--bg-3);border-color:var(--border-1)}
.voice-ctrl-leave{background:rgba(255,59,59,0.15);border-color:rgba(255,59,59,0.3);color:var(--accent)}
.voice-panel.fullscreen .voice-ctrl-btn{width:54px;height:54px;font-size:22px}
.deafen-active{background:rgba(220,38,38,0.25)!important;border-color:rgba(220,38,38,0.5)!important;color:#ff5555!important}
.mic-test-active{background:linear-gradient(135deg,#00ff88,#00cc66)!important;color:#000!important;animation:pulse-mic 1s infinite}
@keyframes pulse-mic{0%,100%{box-shadow:0 0 0 0 rgba(0,255,136,0.7)}50%{box-shadow:0 0 0 12px rgba(0,255,136,0)}}

@media(max-width:900px){
    .sidebar{transform:translateX(-100%);width:280px}
    .sidebar.open{transform:translateX(0)}
    .main{margin-left:0}
    .menu-btn{display:flex}
    .content{padding:24px}
    .topbar{padding:0 24px}
    .page-title{font-size:28px}
    .chat-layout{grid-template-columns:1fr!important;height:calc(100vh - 200px)}
    .chat-layout>.chat-sidebar:nth-child(3){display:none}
    .chat-sidebar:first-child{position:absolute;top:0;left:0;bottom:0;width:260px;z-index:10;transform:translateX(-100%);transition:transform 0.3s}
    .chat-sidebar.mobile-open{transform:translateX(0)}
    .chat-mobile-toggle{display:flex}
    .voice-panel{bottom:12px;right:12px;left:12px;width:auto}
    .voice-tile{min-width:65px;max-width:80px;width:80px}
    .voice-panel.fullscreen .voice-ctrl-btn{width:48px;height:48px;font-size:20px}
}
@media(max-width:768px){
    .content{padding:18px}
    .topbar{padding:0 18px;height:60px}
    .page-header{margin-bottom:22px;flex-direction:column;align-items:stretch}
    .page-title{font-size:24px}
    .card{padding:22px}
    .form-row{grid-template-columns:1fr}
    .btn{padding:12px 18px}
}
`;

const TOAST_SCRIPT = `
function showToast(message,type){if(type===undefined)type='success';var e=document.querySelector('.toast');if(e)e.remove();var t=document.createElement('div');t.className='toast '+type;t.textContent=message;document.body.appendChild(t);setTimeout(function(){t.classList.add('hiding');setTimeout(function(){t.remove()},300)},2400)}
function copyText(text,btn){navigator.clipboard.writeText(text).then(function(){if(btn){var o=btn.innerHTML;btn.innerHTML='✓';setTimeout(function(){btn.innerHTML=o},1400)}showToast('Copied')}).catch(function(){showToast('Failed','error')})}
function confirmDelete(token,name){if(confirm('Delete "'+name+'"?'))window.location.href='/delete/'+token}
function toggleSidebar(){document.querySelector('.sidebar').classList.toggle('open');document.querySelector('.overlay').classList.toggle('active')}
document.querySelectorAll('.nav-item').forEach(function(i){i.addEventListener('click',function(){if(window.innerWidth<=900){document.querySelector('.sidebar').classList.remove('open');document.querySelector('.overlay').classList.remove('active')}})});
`;

function renderLayout(opts) {
    var title = opts.title;
    var pageTitle = opts.pageTitle;
    var pageSubtitle = opts.pageSubtitle;
    var content = opts.content;
    var user = opts.user;
    var activeNav = opts.activeNav;
    var actions = opts.actions;
    var isAdmin = user.role === 'ADMIN';
    return '<!DOCTYPE html><html lang="en"><head>' + getHtmlHead(title) + '<style>' + LAYOUT_STYLES + '</style></head><body>' +
    '<div class="layout">' +
        '<aside class="sidebar" id="sidebar">' +
            '<div class="sidebar-brand"><div class="sidebar-logo">ZK</div><div class="sidebar-brand-text"><div class="sidebar-brand-name">' + BRAND_SHORT + '</div><div class="sidebar-brand-sub">By Zyrox-Kido</div></div></div>' +
            '<nav class="sidebar-nav">' +
                '<div class="nav-section-label">Workspace</div>' +
                '<a href="/" class="nav-item ' + (activeNav === 'dashboard' ? 'active' : '') + '"><span class="nav-icon">◈</span> Dashboard</a>' +
                '<a href="/create" class="nav-item ' + (activeNav === 'create' ? 'active' : '') + '"><span class="nav-icon">✦</span> Create Script</a>' +
                '<a href="/servers" class="nav-item ' + (activeNav === 'servers' ? 'active' : '') + '"><span class="nav-icon">🏠</span> Servers</a>' +
                '<a href="/friends" class="nav-item ' + (activeNav === 'friends' ? 'active' : '') + '"><span class="nav-icon">👥</span> Friends</a>' +
                (isAdmin ? '<div class="nav-section-label">Administration</div><a href="/admin" class="nav-item ' + (activeNav === 'admin' ? 'active' : '') + '"><span class="nav-icon">♛</span> Admin Panel</a>' : '') +
            '</nav>' +
            '<div class="sidebar-footer"><a href="/logout" class="user-card"><div class="user-avatar ' + (isAdmin ? 'user-avatar-admin' : '') + '">' + user.username.charAt(0).toUpperCase() + '</div><div class="user-meta"><div class="user-name">' + user.username + '</div><div class="user-role">' + (isAdmin ? '♛ Admin' : 'Member') + '</div></div></a></div>' +
        '</aside>' +
        '<div class="overlay" onclick="toggleSidebar()"></div>' +
        '<div class="main">' +
            '<header class="topbar"><div class="topbar-left"><button class="menu-btn" onclick="toggleSidebar()">☰</button><div class="topbar-title">' + pageTitle + '</div></div><div class="topbar-right"><a href="/logout" class="icon-btn">⏻</a></div></header>' +
            '<div class="content"><div class="page-header"><div><div class="page-title">' + pageTitle + '</div>' + (pageSubtitle ? '<div class="page-subtitle">' + pageSubtitle + '</div>' : '') + '</div>' + (actions || '') + '</div>' + content + '</div>' +
        '</div>' +
    '</div>' +
    '<script>' + TOAST_SCRIPT + '</script>' +
    '</body></html>';
}

function renderScriptCard(s) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
    const slug = s.slug || 'Script';
    const version = s.version || 'V1';
    const prettyUrl = baseUrl + '/raw/' + slug + '/' + version + '/' + s.token;
    return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;"><div style="display:flex;gap:12px;"><div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:19px;">◈</div><div><div style="font-family:\'Space Grotesk\',sans-serif;font-size:16px;font-weight:700;margin-bottom:6px;">' + s.name + '</div><div style="display:flex;gap:8px;font-size:11.5px;color:var(--text-2);"><span class="badge badge-version">' + version + '</span><span>' + new Date(s.created_at).toLocaleDateString() + '</span></div></div></div></div><div style="background:var(--bg-0);border:1px solid var(--border-0);border-radius:10px;padding:12px 14px;font-family:\'JetBrains Mono\',monospace;font-size:10.5px;color:var(--accent-bright);word-break:break-all;margin-top:14px;">' + prettyUrl + '</div><div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="copyText(\'loadstring(game:HttpGet(\\\'' + prettyUrl + '\\\'))()\', this)">📋 Copy</button><a href="/view/' + slug + '/' + version + '/' + s.token + '" target="_blank" class="btn btn-secondary btn-sm">◉ View</a><a href="/edit/' + s.token + '" class="btn btn-ghost btn-sm">✎ Edit</a><button class="btn btn-danger btn-sm" onclick="confirmDelete(\'' + s.token + '\', \'' + s.name + '\')">🗑 Delete</button></div></div>';
}

// ==================== AUTH ====================
app.get('/login', function(req, res) {
    res.send('<!DOCTYPE html><html><head>' + getHtmlHead('Login') + '<style>' + LAYOUT_STYLES + '</style></head><body>' +
    '<div class="login-wrap"><div class="login-card"><div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">Welcome back</div><div class="login-sub">Sign in to continue</div></div>' +
    '<form action="/login" method="POST"><input type="text" name="username" placeholder="Username" required autofocus><input type="password" name="password" placeholder="Password" required><button type="submit" class="btn btn-primary" style="width:100%">Sign In →</button></form>' +
    '<div class="login-msg error">' + (req.query.error ? 'Invalid credentials' : '') + '</div>' +
    '<div class="login-msg success">' + (req.query.registered ? 'Account created!' : '') + '</div>' +
    '<a href="/register" class="login-link">Create an account →</a>' +
    '</div></div></body></html>');
});
app.post('/login', async function(req, res) {
    try { const { username, password } = req.body; const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]); if (r.rows.length === 0) return res.redirect('/login?error=1'); const u = r.rows[0]; if (u.password !== password) return res.redirect('/login?error=1'); req.session.user = { username: u.username, role: u.role }; res.redirect('/'); } catch (e) { res.redirect('/login?error=1'); }
});
app.get('/register', function(req, res) {
    res.send('<!DOCTYPE html><html><head>' + getHtmlHead('Register') + '<style>' + LAYOUT_STYLES + '</style></head><body>' +
    '<div class="login-wrap"><div class="login-card"><div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">Create account</div><div class="login-sub">Join ' + BRAND_SHORT + '</div></div>' +
    '<form action="/register" method="POST"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><input type="password" name="confirmPassword" placeholder="Confirm password" required><button type="submit" class="btn btn-primary" style="width:100%">Create Account →</button></form>' +
    '<div class="login-msg error">' + (req.query.error || '') + '</div><a href="/login" class="login-link">← Back to sign in</a>' +
    '</div></div></body></html>');
});
app.post('/register', async function(req, res) {
    try { const { username, password, confirmPassword } = req.body; if (password !== confirmPassword) return res.redirect('/register?error=Passwords do not match'); if (username.length < 2 || password.length < 4) return res.redirect('/register?error=Min 2 chars, 4 chars pass'); const ex = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]); if (ex.rows.length > 0) return res.redirect('/register?error=Username taken'); const role = username === 'Z-K' ? 'ADMIN' : 'USER'; const tag = Math.floor(1000 + Math.random() * 9000).toString(); await pool.query('INSERT INTO users (username, password, role, display_name, tag) VALUES ($1, $2, $3, $4, $5)', [username, password, role, username, tag]); res.redirect('/login?registered=1'); } catch (e) { res.redirect('/register?error=Server error'); }
});
app.get('/logout', function(req, res) { req.session.destroy(); res.redirect('/login'); });

// ==================== DASHBOARD ====================
app.get('/', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [req.session.user.username]);
        const myScripts = r.rows;
        const isAdmin = req.session.user.role === 'ADMIN';
        const stats = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:32px;"><div class="card"><div style="width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:16px;">◈</div><div style="font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:6px;">Total Scripts</div><div style="font-family:\'Space Grotesk\',sans-serif;font-size:30px;font-weight:700;">' + myScripts.length + '</div></div><div class="card"><div style="width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:16px;">' + (isAdmin ? '♛' : '★') + '</div><div style="font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:6px;">Role</div><div style="font-family:\'Space Grotesk\',sans-serif;font-size:22px;font-weight:700;">' + (isAdmin ? 'Admin' : 'Member') + '</div></div></div>';
        const scriptsHtml = myScripts.length === 0 ? '<div class="empty"><div class="empty-icon">◈</div><div class="empty-title">No scripts yet</div><div class="empty-desc">Create your first script</div><a href="/create" class="btn btn-primary">✦ Create Script</a></div>' : '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;">' + myScripts.map(renderScriptCard).join('') + '</div>';
        res.send(renderLayout({ title: 'Dashboard', pageTitle: 'Dashboard', pageSubtitle: 'Manage your Lua scripts', content: stats + scriptsHtml, user: req.session.user, activeNav: 'dashboard', actions: '<a href="/create" class="btn btn-primary">✦ New Script</a>' }));
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/create', requireLogin, function(req, res) {
    const content = '<div class="card" style="max-width:920px"><form action="/create" method="POST"><div class="form-row"><div class="form-group"><label class="form-label">Script Name</label><input type="text" name="name" required autofocus></div><div class="form-group"><label class="form-label">Version</label><select name="version" required>' + versionDropdown('V1') + '</select></div></div><div class="form-group"><label class="form-label">Lua Code</label><textarea name="content" required></textarea></div><div style="display:flex;gap:12px;"><button type="submit" class="btn btn-primary">💾 Save</button><a href="/" class="btn btn-ghost">Cancel</a></div></form></div>';
    res.send(renderLayout({ title: 'Create', pageTitle: 'Create Script', pageSubtitle: 'Add a new Lua script', content: content, user: req.session.user, activeNav: 'create' }));
});
app.post('/create', requireLogin, async function(req, res) {
    try { const { name, version, content } = req.body; const slug = makeSlug(name); const ver = version || 'V1'; const token = crypto.randomBytes(16).toString('hex'); await pool.query('INSERT INTO scripts (name, slug, version, real_content, public_content, token, owner) VALUES ($1, $2, $3, $4, $5, $6, $7)', [name, slug, ver, content, obfuscateScript(content), token, req.session.user.username]); res.redirect('/'); } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/edit/:token', requireLogin, async function(req, res) {
    try { const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]); if (r.rows.length === 0) return res.status(404).send("Not found"); const s = r.rows[0]; const isAdmin = req.session.user.role === 'ADMIN'; if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied"); const escaped = s.real_content.replace(/</g, '&lt;').replace(/>/g, '&gt;'); const content = '<div class="card" style="max-width:920px"><form action="/edit/' + s.token + '" method="POST"><div class="form-row"><div class="form-group"><label class="form-label">Script Name</label><input type="text" name="name" value="' + s.name + '" required></div><div class="form-group"><label class="form-label">Version</label><select name="version" required>' + versionDropdown(s.version) + '</select></div></div><div class="form-group"><label class="form-label">Lua Code</label><textarea name="content" required>' + escaped + '</textarea></div><div style="display:flex;gap:12px;"><button type="submit" class="btn btn-primary">💾 Save</button><a href="/" class="btn btn-ghost">Cancel</a></div></form></div>'; res.send(renderLayout({ title: 'Edit', pageTitle: 'Edit: ' + s.name, pageSubtitle: 'Update your script', content: content, user: req.session.user, activeNav: 'dashboard' })); } catch (e) { res.status(500).send('Error'); }
});
app.post('/edit/:token', requireLogin, async function(req, res) {
    try { const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]); if (r.rows.length === 0) return res.status(404).send("Not found"); const s = r.rows[0]; const isAdmin = req.session.user.role === 'ADMIN'; if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied"); const slug = makeSlug(req.body.name); const ver = req.body.version || 'V1'; await pool.query('UPDATE scripts SET name = $1, slug = $2, version = $3, real_content = $4, public_content = $5 WHERE token = $6', [req.body.name, slug, ver, req.body.content, obfuscateScript(req.body.content), req.params.token]); res.redirect('/'); } catch (e) { res.status(500).send('Error'); }
});

app.get('/view/:slug/:version/:token', async function(req, res) {
    try { const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]); if (r.rows.length === 0) return res.status(404).send("Not found"); const s = r.rows[0]; const baseUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT); const prettyUrl = baseUrl + '/raw/' + s.slug + '/' + s.version + '/' + s.token; const loadstring = 'loadstring(game:HttpGet("' + prettyUrl + '"))()'; res.send('<!DOCTYPE html><html><head>' + getHtmlHead(s.name) + '<style>' + LAYOUT_STYLES + '</style></head><body><div class="login-wrap"><div class="login-card" style="width:640px;text-align:center;"><div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">' + s.name + '</div><div class="login-sub" style="margin-top:10px;"><span class="badge badge-version">' + s.version + '</span></div></div><div style="background:var(--bg-0);border:1px solid var(--border-0);border-radius:12px;padding:18px;margin-bottom:18px;text-align:left;"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:12px;">Loadstring</div><div id="lsBox" style="font-family:\'JetBrains Mono\',monospace;font-size:11.5px;color:var(--accent-bright);word-break:break-all;line-height:1.8;">' + loadstring + '</div></div><button class="btn btn-primary" style="width:100%;padding:15px;" onclick="copyText(document.getElementById(\'lsBox\').innerText, this)">📋 Copy Loadstring</button><div style="margin-top:24px;font-size:11px;color:var(--text-3);font-weight:600;">Protected by ' + BRAND_NAME + '</div></div></div><script>' + TOAST_SCRIPT + '</script></body></html>'); } catch (e) { res.status(500).send('Error'); }
});

app.get('/raw/:slug/:version/:token', async function(req, res) {
    try { const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]); if (r.rows.length === 0) return res.status(403).send("-- Denied --"); const s = r.rows[0]; if (s.slug !== req.params.slug || s.version !== req.params.version) return res.status(403).send("-- Denied --"); const ua = req.headers['user-agent'] || ''; for (const b of ['Mozilla', 'Chrome', 'Safari', 'Firefox', 'Edge', 'curl', 'wget']) if (ua.includes(b)) return res.status(403).send("-- Protected --"); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.send(s.public_content); } catch (e) { res.status(500).send("-- Error --"); }
});

app.get('/delete/:token', requireLogin, async function(req, res) {
    try { const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]); if (r.rows.length === 0) return res.redirect('/'); const s = r.rows[0]; const isAdmin = req.session.user.role === 'ADMIN'; if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied"); await pool.query('DELETE FROM scripts WHERE token = $1', [req.params.token]); if (isAdmin && s.owner !== req.session.user.username) return res.redirect('/admin/user/' + encodeURIComponent(s.owner)); res.redirect('/'); } catch (e) { res.status(500).send('Error'); }
});

// ==================== SERVERS ====================
app.get('/servers', requireLogin, async function(req, res) {
    const me = req.session.user.username;
    const r = await pool.query('SELECT s.*, (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count FROM servers s WHERE s.owner = $1 OR s.id IN (SELECT server_id FROM server_members WHERE username = $1) ORDER BY s.created_at DESC', [me]);
    let cards = '';
    if (r.rows.length === 0) { cards = '<div class="empty"><div class="empty-icon">🏠</div><div class="empty-title">No servers yet</div><div class="empty-desc">Create your first server</div></div>'; }
    else {
        cards = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;">';
        r.rows.forEach(function(s) {
            const isOwner = s.owner === me;
            cards += '<div class="card" style="cursor:pointer" onclick="window.location.href=\'/server/' + s.id + '\'"><div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;"><div style="width:44px;height:44px;border-radius:12px;background:var(--bg-2);display:flex;align-items:center;justify-content:center;font-size:22px;">' + (s.icon || '🎮') + '</div><div><div style="font-family:\'Space Grotesk\',sans-serif;font-size:16px;font-weight:700;">' + s.name + '</div><div style="display:flex;gap:8px;margin-top:4px;">' + (isOwner ? '<span class="badge badge-owner">👑 Owner</span>' : '<span class="badge badge-user">Member</span>') + '<span style="font-size:11px;color:var(--text-3);">' + s.member_count + ' members</span></div></div></div><div style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text-3);">Invite: <span style="color:var(--accent-bright);">' + s.invite_code + '</span></div><div style="display:flex;gap:8px;margin-top:14px;" onclick="event.stopPropagation()"><a href="/server/' + s.id + '" class="btn btn-primary btn-sm">Open</a><button onclick="copyText(\'' + s.invite_code + '\', this)" class="btn btn-secondary btn-sm">📋 Invite</button></div></div>';
        });
        cards += '</div>';
    }
    const content = '<div style="display:flex;gap:10px;margin-bottom:20px;"><button onclick="document.getElementById(\'createServerModal\').style.display=\'flex\'" class="btn btn-primary">➕ Create Server</button><button onclick="document.getElementById(\'joinServerModal\').style.display=\'flex\'" class="btn btn-secondary">🔗 Join Server</button></div>' + cards +
    '<div id="createServerModal" class="modal-overlay" style="display:none"><div class="modal-card"><div class="modal-header"><h3 style="font-size:18px;">Create Server</h3><button onclick="document.getElementById(\'createServerModal\').style.display=\'none\'" class="modal-close">×</button></div><div class="modal-body"><label class="form-label">Server Name</label><input type="text" id="newServerName" maxlength="100" placeholder="My Server"><label class="form-label" style="margin-top:14px;">Icon</label><input type="text" id="newServerIcon" value="🎮" maxlength="2"></div><div class="modal-footer"><button onclick="document.getElementById(\'createServerModal\').style.display=\'none\'" class="btn btn-ghost">Cancel</button><button onclick="createServer()" class="btn btn-primary">Create</button></div></div></div>' +
    '<div id="joinServerModal" class="modal-overlay" style="display:none"><div class="modal-card"><div class="modal-header"><h3 style="font-size:18px;">Join Server</h3><button onclick="document.getElementById(\'joinServerModal\').style.display=\'none\'" class="modal-close">×</button></div><div class="modal-body"><label class="form-label">Invite Code</label><input type="text" id="joinInviteCode" placeholder="Paste invite code"></div><div class="modal-footer"><button onclick="document.getElementById(\'joinServerModal\').style.display=\'none\'" class="btn btn-ghost">Cancel</button><button onclick="joinServer()" class="btn btn-primary">Join</button></div></div></div>' +
    '<script>' +
    'async function createServer(){const name=document.getElementById(\'newServerName\').value.trim();const icon=document.getElementById(\'newServerIcon\').value.trim()||\'🎮\';if(!name)return showToast(\'Name required\',\'error\');const r=await fetch(\'/api/servers/create\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({name,icon})});const d=await r.json();if(d.id)window.location.href=\'/server/\'+d.id;else showToast(d.error,\'error\')}' +
    'async function joinServer(){const code=document.getElementById(\'joinInviteCode\').value.trim();if(!code)return showToast(\'Code required\',\'error\');const r=await fetch(\'/api/servers/join\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({invite_code:code})});const d=await r.json();if(d.id)window.location.href=\'/server/\'+d.id;else showToast(d.error||\'Invalid\',\'error\')}' +
    '</script>';
    res.send(renderLayout({ title: 'Servers', pageTitle: 'Servers', pageSubtitle: 'Your Discord-style servers', content: content, user: req.session.user, activeNav: 'servers' }));
});

app.post('/api/servers/create', requireLogin, async function(req, res) {
    try { const { name, icon } = req.body; if (!name || name.length < 2) return res.status(400).json({ error: 'Name too short' }); const invite = crypto.randomBytes(6).toString('hex'); const r = await pool.query('INSERT INTO servers (name, owner, invite_code, icon) VALUES ($1, $2, $3, $4) RETURNING *', [name.substring(0, 100), req.session.user.username, invite, (icon || '🎮').substring(0, 2)]); const srv = r.rows[0]; await pool.query('INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, $3)', [srv.id, req.session.user.username, 'OWNER']); await pool.query('INSERT INTO channels (server_id, name, type, created_by, visibility) VALUES ($1, $2, $3, $4, $5)', [srv.id, 'general', 'text', req.session.user.username, 'public']); await pool.query('INSERT INTO channels (server_id, name, type, created_by, visibility) VALUES ($1, $2, $3, $4, $5)', [srv.id, 'voice', 'voice', req.session.user.username, 'public']); res.json(srv); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/join', requireLogin, async function(req, res) {
    try { const { invite_code } = req.body; const r = await pool.query('SELECT * FROM servers WHERE invite_code = $1', [invite_code]); if (r.rows.length === 0) return res.status(404).json({ error: 'Invalid code' }); const srv = r.rows[0]; const ex = await pool.query('SELECT * FROM server_members WHERE server_id = $1 AND username = $2', [srv.id, req.session.user.username]); if (ex.rows.length === 0) await pool.query('INSERT INTO server_members (server_id, username) VALUES ($1, $2)', [srv.id, req.session.user.username]); res.json(srv); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/:id/kick', requireLogin, async function(req, res) {
    try {
        const serverId = parseInt(req.params.id);
        const { targetUser } = req.body;
        const me = req.session.user.username;
        const isGlobalAdmin = req.session.user.role === 'ADMIN';
        const srvR = await pool.query('SELECT * FROM servers WHERE id = $1', [serverId]);
        if (srvR.rows.length === 0) return res.status(404).json({ error: 'Server not found' });
        const srv = srvR.rows[0];
        const isOwner = srv.owner === me;
        if (!isOwner && !isGlobalAdmin) return res.status(403).json({ error: 'Only owner/admin can kick' });
        if (targetUser === me) return res.status(400).json({ error: 'Cannot kick yourself' });
        if (targetUser === srv.owner) return res.status(400).json({ error: 'Cannot kick owner' });
        await pool.query('DELETE FROM server_members WHERE server_id = $1 AND username = $2', [serverId, targetUser]);
        await pool.query('DELETE FROM channels WHERE server_id = $1 AND created_by = $2 AND owner_only = TRUE', [serverId, targetUser]);
        const targetSocket = Array.from(io.sockets.sockets.values()).find(function(s) { return s.username === targetUser; });
        if (targetSocket) {
            if (targetSocket.voiceChannelId) {
                const tVcId = targetSocket.voiceChannelId;
                const tR = voiceRooms.get(tVcId);
                if (tR) {
                    tR.delete(targetSocket.id);
                    if (tR.size === 0) voiceRooms.delete(tVcId);
                    else io.to('voice_' + tVcId).emit('voice_participants', Array.from(tR.values()));
                }
                targetSocket.leave('voice_' + tVcId);
                targetSocket.voiceChannelId = null;
            }
            targetSocket.emit('you_were_kicked_from_server', { serverId, by: me });
        }
        io.emit('server_member_kicked', { serverId, username: targetUser });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/:id/channels', requireLogin, async function(req, res) {
    try {
        const serverId = parseInt(req.params.id);
        const { name, type, visibility } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        const cleanName = name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-').substring(0, 30);
        if (!cleanName) return res.status(400).json({ error: 'Invalid name' });
        const chk = await pool.query('SELECT * FROM channels WHERE server_id = $1 AND name = $2', [serverId, cleanName]);
        if (chk.rows.length > 0) return res.status(400).json({ error: 'Exists' });
        const vis = visibility || 'public';
        const ownerOnly = vis === 'personal';
        const r = await pool.query('INSERT INTO channels (server_id, name, type, created_by, visibility, owner_only) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [serverId, cleanName, type === 'voice' ? 'voice' : 'text', req.session.user.username, vis, ownerOnly]);
        io.emit('channel_created', r.rows[0]);
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/channels/:id/rename', requireLogin, async function(req, res) {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        const chk = await pool.query('SELECT c.*, s.owner FROM channels c JOIN servers s ON c.server_id = s.id WHERE c.id = $1', [req.params.id]);
        if (chk.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const ch = chk.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (ch.owner !== req.session.user.username && ch.created_by !== req.session.user.username && !isAdmin) return res.status(403).json({ error: 'Denied' });
        const cleanName = name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-').substring(0, 30);
        await pool.query('UPDATE channels SET name = $1 WHERE id = $2', [cleanName, req.params.id]);
        io.emit('channel_renamed', { id: parseInt(req.params.id), name: cleanName });
        res.json({ success: true });
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
        const textChannels = channels.filter(function(c) { return c.type !== 'voice'; });
        const voiceChannels = channels.filter(function(c) { return c.type === 'voice'; });
        const membersR = await pool.query('SELECT sm.*, u.role as global_role FROM server_members sm LEFT JOIN users u ON LOWER(u.username) = LOWER(sm.username) WHERE sm.server_id = $1 ORDER BY sm.role ASC, sm.username ASC', [serverId]);

        const visibleText = textChannels.filter(function(c) {
            if (c.owner_only && c.created_by !== me && !isOwner && !isGlobalAdmin) return false;
            return true;
        });
        const visibleVoice = voiceChannels.filter(function(c) {
            if (c.owner_only && c.created_by !== me && !isOwner && !isGlobalAdmin) return false;
            return true;
        });

        const membersHtml = membersR.rows.map(function(m) {
            const isGlobalAdminM = m.global_role === 'ADMIN';
            const isOwnerM = m.role === 'OWNER';
            let badge = '';
            let nameColor = 'var(--text-1)';
            if (isOwnerM) { badge = '<span class="badge badge-owner" style="font-size:8px;padding:1px 5px;margin-left:4px;">👑</span>'; nameColor = '#7cc0ff'; }
            else if (isGlobalAdminM) { badge = '<span class="badge badge-admin" style="font-size:8px;padding:1px 5px;margin-left:4px;">♛</span>'; nameColor = '#ffbb44'; }
            const canKick = (isOwner || isGlobalAdmin) && m.username !== me && !isOwnerM;
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:13px;font-weight:600;color:' + nameColor + ';" data-member="' + m.username + '">' +
                '<div style="width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;">' + m.username.charAt(0).toUpperCase() + '</div>' +
                '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + m.username + '</span>' +
                badge +
                (canKick ? '<button onclick="kickMember(\'' + m.username + '\')" class="channel-icon-btn" title="Kick from server">👢</button>' : '') +
            '</div>';
        }).join('');

        // Build the entire content via string concat
        let content = '';
        content += '<div class="chat-layout">';
        content += '<div class="chat-sidebar" id="chatSidebar">';
        content += '<div class="chat-sidebar-header">';
        content += '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;"><span style="font-size:20px;">' + (srv.icon || '🎮') + '</span><span style="font-family:\'Space Grotesk\',sans-serif;font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + srv.name + '</span></div>';
        content += '</div>';
        content += '<div class="chat-channels-list">';
        content += '<div class="channel-group-label"><span>💬 TEXT</span><button onclick="openCreateChannel(\'text\')" title="Create">+</button></div>';
        content += '<div id="channelsList">' + visibleText.map(function(c) { return renderChannelItem(c, me, isOwner, isGlobalAdmin); }).join('') + '</div>';
        content += '<div class="channel-group-label" style="margin-top:16px;"><span>🔊 VOICE</span><button onclick="openCreateChannel(\'voice\')" title="Create">+</button></div>';
        content += '<div id="voiceChannelsList">' + visibleVoice.map(function(c) { return renderVoiceChannelItem(c, me, isOwner, isGlobalAdmin); }).join('') + '</div>';
        content += '</div>';
        content += '<div class="chat-sidebar-footer"><a href="/servers" style="display:block;text-align:center;color:var(--text-2);font-size:12px;font-weight:700;padding:8px;">← All Servers</a></div>';
        content += '</div>';
        content += '<div class="chat-main">';
        content += '<div class="chat-header">';
        content += '<div style="display:flex;align-items:center;gap:8px;">';
        content += '<button class="chat-mobile-toggle" onclick="toggleChatSidebar()">☰</button>';
        content += '<span style="color:var(--text-2);font-size:18px;">#</span>';
        content += '<span id="currentChannelName" style="font-family:\'Space Grotesk\',sans-serif;font-weight:700;font-size:15px;">' + (visibleText[0] ? visibleText[0].name : 'general') + '</span>';
        content += '<span id="channelBadge" style="display:none;"></span>';
        content += '</div>';
        content += '<div style="font-size:11px;color:var(--text-3);font-weight:600;">Invite: ' + srv.invite_code + '</div>';
        content += '</div>';
        content += '<div id="chatMessages" class="chat-messages"><div style="text-align:center;color:var(--text-3);padding:20px 0;">Loading...</div></div>';
        content += '<div class="chat-input-area" id="chatInputArea"><form id="chatForm"><input type="text" id="chatInput" placeholder="Message..." maxlength="500" autocomplete="off"><button type="submit" class="btn btn-primary">➤</button></form></div>';
        content += '<div id="readOnlyNotice" style="display:none;padding:16px 20px;border-top:1px solid var(--border-0);background:var(--bg-0);color:var(--text-3);text-align:center;font-size:13px;font-weight:600;">🔒 Read-only channel</div>';
        content += '</div>';
        content += '<div class="chat-sidebar" style="border-left:1px solid var(--border-0);border-right:none;">';
        content += '<div class="chat-sidebar-header" style="font-family:\'Space Grotesk\',sans-serif;font-weight:700;font-size:13px;">👥 Members (' + membersR.rows.length + ')</div>';
        content += '<div style="overflow-y:auto;flex:1;padding:10px 8px;">' + membersHtml + '</div>';
        content += '</div>';
        content += '</div>';

        // Voice panel
        content += '<div id="voicePanel" class="voice-panel" style="display:none;">';
        content += '<div class="voice-panel-header">';
        content += '<div style="display:flex;align-items:center;gap:8px;"><div class="voice-live-dot"></div><span id="voicePanelName" style="font-weight:700;font-size:13px;">Voice</span></div>';
        content += '<div style="display:flex;gap:6px;">';
        content += '<button onclick="toggleFullscreenVoice()" class="voice-min-btn" id="fullscreenBtn" title="Full Screen">⛶</button>';
        content += '<button onclick="minimizeVoice()" class="voice-min-btn" title="Minimize">−</button>';
        content += '</div>';
        content += '</div>';
        content += '<div class="voice-body">';
        content += '<div class="voice-main-view" id="voiceMainView">';
        content += '<video id="voiceMainVideo" autoplay playsinline muted></video>';
        content += '<div class="voice-main-avatar" id="voiceMainAvatar">';
        content += '<div class="voice-main-avatar-circle" id="voiceMainAvatarCircle">?</div>';
        content += '<div class="voice-main-avatar-name" id="voiceMainAvatarName">User</div>';
        content += '<div class="voice-main-avatar-status" id="voiceMainAvatarStatus">No screen sharing</div>';
        content += '</div>';
        content += '<div class="voice-main-label" id="voiceMainLabel">👤 You</div>';
        content += '<button class="voice-main-back" id="voiceMainBack" onclick="focusSelf()">← Back to You</button>';
        content += '</div>';
        content += '<div id="voiceParticipantsStrip" class="voice-participants-strip"></div>';
        content += '</div>';
        content += '<div class="voice-controls">';
        content += '<button id="muteBtn" onclick="toggleMute()" class="voice-ctrl-btn" title="Mute">🎤</button>';
        content += '<button id="deafBtn" onclick="toggleDeafen()" class="voice-ctrl-btn" title="Deafen">🎧</button>';
        content += '<button id="shareBtn" onclick="toggleShareScreen()" class="voice-ctrl-btn" title="Share Screen">🖥️</button>';
        content += '<button id="micTestBtn" onclick="toggleMicTest()" class="voice-ctrl-btn" title="Test Mic">🎙️</button>';
        content += '<button onclick="leaveVoice()" class="voice-ctrl-btn voice-ctrl-leave" title="Disconnect">📞</button>';
        content += '</div>';
        content += '</div>';

        // Modals
        content += '<div id="createChannelModal" class="modal-overlay" style="display:none;"><div class="modal-card"><div class="modal-header"><h3 style="font-size:18px;" id="createChannelTitle">Create Channel</h3><button onclick="closeModal(\'createChannelModal\')" class="modal-close">×</button></div><div class="modal-body"><label class="form-label">Channel Name</label><input type="text" id="newChannelName" placeholder="e.g., gaming" maxlength="50"><label class="form-label" style="margin-top:14px;">Visibility</label><select id="newChannelVis"><option value="public">🌐 Public — Everyone sees & chats</option><option value="private">🔒 Private — Everyone sees but read-only</option><option value="personal">👑 Personal — Only you can see</option></select></div><div class="modal-footer"><button onclick="closeModal(\'createChannelModal\')" class="btn btn-ghost">Cancel</button><button onclick="createChannel()" class="btn btn-primary">Create</button></div></div></div>';
        content += '<div id="renameChannelModal" class="modal-overlay" style="display:none;"><div class="modal-card"><div class="modal-header"><h3 style="font-size:18px;">Rename Channel</h3><button onclick="closeModal(\'renameChannelModal\')" class="modal-close">×</button></div><div class="modal-body"><label class="form-label">New Name</label><input type="text" id="renameChannelInput" maxlength="50"></div><div class="modal-footer"><button onclick="closeModal(\'renameChannelModal\')" class="btn btn-ghost">Cancel</button><button onclick="saveRename()" class="btn btn-primary">Save</button></div></div></div>';

        // Script
        content += '<script src="/socket.io/socket.io.js"></script>';
        content += '<script>';
        content += 'const SERVER_ID = ' + serverId + ';';
        content += 'const CURRENT_USER = ' + JSON.stringify(me) + ';';
        content += 'const CURRENT_ROLE = ' + JSON.stringify(req.session.user.role) + ';';
        content += 'const IS_OWNER = ' + isOwner + ';';
        content += 'const IS_GLOBAL_ADMIN = ' + isGlobalAdmin + ';';
        content += 'const socket = io();';
        content += 'let currentChannelId = null;';
        content += 'let currentChannelType = "text";';
        content += 'let currentChannelVis = "public";';
        content += 'let currentChannelOwner = "";';
        content += 'let localStream=null, screenStream=null;';
        content += 'let peerConnections={};';
        content += 'let currentVoiceChannelId=null;';
        content += 'let isMuted=false, isDeafened=false, isSharing=false;';
        content += 'let micTestActive=false;';
        content += 'let micTestAudio=null;';
        content += 'let viewingSocketId=null;';
        content += 'const voiceStreams = {};';
        content += 'const iceServers={iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}]};';
        content += 'const messagesEl=document.getElementById("chatMessages");';
        content += 'const form=document.getElementById("chatForm");';
        content += 'const input=document.getElementById("chatInput");';
        content += 'socket.emit("register_user",{username:CURRENT_USER});';
        content += 'function escapeHtml(t){const d=document.createElement("div");d.textContent=t;return d.innerHTML}';
        content += 'function formatTime(ts){return new Date(ts).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}';
        content += 'function toggleChatSidebar(){document.getElementById("chatSidebar").classList.toggle("mobile-open")}';
        content += 'function closeModal(id){document.getElementById(id).style.display="none"}';
        content += 'function openCreateChannel(type){currentChannelType=type;document.getElementById("createChannelTitle").textContent=type==="voice"?"Create Voice Channel":"Create Text Channel";document.getElementById("createChannelModal").style.display="flex";document.getElementById("newChannelName").value=""}';
        content += 'async function createChannel(){const name=document.getElementById("newChannelName").value.trim();const vis=document.getElementById("newChannelVis").value;if(!name)return showToast("Name required","error");const r=await fetch("/api/servers/"+SERVER_ID+"/channels",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name,type:currentChannelType,visibility:vis})});const d=await r.json();if(d.id){addChannelToSidebar(d);closeModal("createChannelModal");showToast("Channel created!","success")}else showToast(d.error,"error")}';
        content += 'function addChannelToSidebar(c){';
        content += 'if(c.type==="voice"){const list=document.getElementById("voiceChannelsList");const div=document.createElement("div");div.className="voice-channel-item";div.dataset.id=c.id;div.innerHTML=\'<div class="voice-item-header"><span>🔊</span><span class="voice-name">\'+escapeHtml(c.name)+\'</span><span class="voice-count" id="voice-count-\'+c.id+\'" style="display:none;">0</span></div><div class="voice-participants" id="voice-participants-\'+c.id+\'"></div><button class="voice-join-btn" onclick="joinVoice(\'+c.id+\',\\\'\'+c.name.replace(/\'/g,"\\\\\'")+\'\\\')">Join</button>\';list.appendChild(div);}';
        content += 'else{const list=document.getElementById("channelsList");const div=document.createElement("div");div.className="channel-item";div.dataset.id=c.id;div.dataset.visibility=c.visibility||"public";div.innerHTML=\'<span class="channel-hash">#</span><span class="channel-name">\'+escapeHtml(c.name)+\'</span>\'+(c.visibility==="private"?\'<span class="badge badge-private" style="font-size:8px;">🔒</span>\':"")+(c.visibility==="personal"?\'<span class="badge badge-personal" style="font-size:8px;">👑</span>\':"")+(IS_OWNER||IS_GLOBAL_ADMIN||c.created_by===CURRENT_USER?\'<div class="channel-icons"><button class="channel-icon-btn" onclick="event.stopPropagation();openRename(\'+c.id+\',\\\'\'+c.name.replace(/\'/g,"\\\\\'")+\'\\\')">✏️</button></div>\':"");div.onclick=function(){switchChannel(c.id,c.name,c.visibility||"public",c.created_by,"text")};list.appendChild(div);}';
        content += '}';
        content += 'function switchChannel(id,name,visibility,owner,type){currentChannelId=id;currentChannelVis=visibility||"public";currentChannelOwner=owner||"";document.getElementById("currentChannelName").textContent=name;input.placeholder=currentChannelVis==="private"?"Read-only":"Message #"+name;document.querySelectorAll(".channel-item").forEach(function(el){el.classList.remove("active")});const a=document.querySelector(\'.channel-item[data-id="\'+id+\'"]\');if(a)a.classList.add("active");messagesEl.innerHTML=\'<div style="text-align:center;color:var(--text-3);padding:20px 0;">Loading...</div>\';socket.emit("switch_channel",{channelId:id});const cantChat=(currentChannelVis==="private"&&!IS_OWNER&&!IS_GLOBAL_ADMIN&&currentChannelOwner!==CURRENT_USER);document.getElementById("chatInputArea").style.display=cantChat?"none":"block";document.getElementById("readOnlyNotice").style.display=cantChat?"block":"none";const badge=document.getElementById("channelBadge");if(currentChannelVis==="private"){badge.className="badge badge-private";badge.textContent="🔒 Read-only";badge.style.display="inline-block"}else if(currentChannelVis==="personal"){badge.className="badge badge-personal";badge.textContent="👑 Personal";badge.style.display="inline-block"}else badge.style.display="none";if(window.innerWidth<=900)document.getElementById("chatSidebar").classList.remove("mobile-open")}';
        content += 'function renderMessage(msg,isNew){const isOwn=msg.username===CURRENT_USER;const isA=msg.role==="ADMIN";const div=document.createElement("div");div.className="chat-message";div.dataset.id=msg.id;if(isNew)div.style.animation="msgIn 0.3s ease";const av=isA?"linear-gradient(135deg,#ffaa00,#ff6600)":"linear-gradient(135deg,var(--red-1),var(--red-2))";const rb=isA?\'<span style="font-size:9px;font-weight:800;color:#ffaa00;background:rgba(255,170,0,0.12);padding:2px 6px;border-radius:5px;margin-left:6px;">♛ ADMIN</span>\':"";div.innerHTML=\'<div class="msg-avatar" style="background:\'+av+\';">\'+escapeHtml(msg.username.charAt(0).toUpperCase())+\'</div><div class="msg-body"><div class="msg-meta"><span class="msg-username" style="color:\'+(isOwn?"var(--accent-bright)":"var(--text-0)")+\';">\'+(isOwn?"You":escapeHtml(msg.username))+\'</span>\'+rb+\'<span class="msg-time">\'+formatTime(msg.created_at)+\'</span></div><div class="msg-content">\'+escapeHtml(msg.message)+\'</div>\'+(IS_GLOBAL_ADMIN&&!isOwn?\'<button class="msg-delete" onclick="deleteMsg(\'+msg.id+\')">🗑</button>\':"")+\'</div>\';return div}';
        content += 'socket.on("chat_history",function(msgs){messagesEl.innerHTML="";if(msgs.length===0){messagesEl.innerHTML=\'<div style="text-align:center;color:var(--text-3);padding:60px 20px;"><div style="font-size:48px;margin-bottom:12px;">👋</div><div style="font-size:15px;font-weight:700;color:var(--text-2);">Welcome!</div></div>\';return}msgs.forEach(function(m){messagesEl.appendChild(renderMessage(m))});messagesEl.scrollTop=messagesEl.scrollHeight});';
        content += 'socket.on("new_message",function(msg){messagesEl.appendChild(renderMessage(msg,true));messagesEl.scrollTop=messagesEl.scrollHeight});';
        content += 'socket.on("message_deleted",function(d){const el=messagesEl.querySelector(\'[data-id="\'+d.messageId+\'"]\');if(el){el.style.opacity="0";setTimeout(function(){el.remove()},300)}});';
        content += 'socket.on("channel_renamed",function(d){const el=document.querySelector(\'.channel-item[data-id="\'+d.id+\'"] .channel-name\');if(el)el.textContent=d.name;const v=document.querySelector(\'.voice-channel-item[data-id="\'+d.id+\'"] .voice-name\');if(v)v.textContent=d.name});';
        content += 'socket.on("channel_created",function(c){if(document.querySelector(\'[data-id="\'+c.id+\'"]\'))return;addChannelToSidebar(c)});';
        content += 'form.addEventListener("submit",function(e){e.preventDefault();const msg=input.value.trim();if(!msg||!currentChannelId)return;socket.emit("send_message",{username:CURRENT_USER,role:CURRENT_ROLE,message:msg,channelId:currentChannelId});input.value=""});';
        content += 'window.deleteMsg=function(id){if(confirm("Delete?"))socket.emit("delete_message",{messageId:id,role:CURRENT_ROLE,channelId:currentChannelId})};';
        content += 'window.openRename=function(id,name){document.getElementById("renameChannelInput").value=name;document.getElementById("renameChannelModal").dataset.channelId=id;document.getElementById("renameChannelModal").style.display="flex"};';
        content += 'window.saveRename=async function(){const id=document.getElementById("renameChannelModal").dataset.channelId;const name=document.getElementById("renameChannelInput").value.trim();if(!name)return;const r=await fetch("/api/channels/"+id+"/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name})});const d=await r.json();if(d.success){showToast("Renamed!","success");closeModal("renameChannelModal")}else showToast(d.error,"error")};';

        // KICK
        content += 'window.kickMember=async function(username){if(!confirm("Kick "+username+" from this server?"))return;try{const r=await fetch("/api/servers/"+SERVER_ID+"/kick",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetUser:username})});const d=await r.json();if(d.success){showToast(username+" kicked","success")}else showToast(d.error||"Failed","error")}catch(e){showToast("Failed","error")}};';
        content += 'socket.on("server_member_kicked",function(d){if(d.serverId!==SERVER_ID)return;const el=document.querySelector(\'[data-member="\'+d.username+\'"]\');if(el){el.style.opacity="0.3";el.style.textDecoration="line-through";setTimeout(function(){el.remove()},1500)}showToast(d.username+" was kicked from server","error")});';
        content += 'socket.on("you_were_kicked_from_server",function(d){if(d.serverId!==SERVER_ID)return;alert("You were kicked from this server by "+d.by);window.location.href="/servers"});';

        // VOICE JOIN
        content += 'window.joinVoice=async function(channelId,channelName){try{if(currentVoiceChannelId===channelId)return;if(currentVoiceChannelId)window.leaveVoice();try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:48000,channelCount:2},video:false})}catch(e){return showToast("Mic denied","error")}currentVoiceChannelId=channelId;viewingSocketId=null;document.getElementById("voicePanelName").textContent=channelName;document.getElementById("voicePanel").style.display="flex";document.getElementById("voicePanel").classList.add("fullscreen");document.body.style.overflow="hidden";document.getElementById("voiceParticipantsStrip").innerHTML="";document.getElementById("voiceMainVideo").srcObject=localStream;document.getElementById("voiceMainVideo").classList.remove("screen-mode");document.getElementById("voiceMainLabel").textContent="👤 You";document.getElementById("voiceMainLabel").classList.remove("live");document.getElementById("voiceMainBack").classList.remove("show");document.getElementById("voiceMainAvatar").classList.remove("show");socket.emit("join_voice",{voiceChannelId:channelId,username:CURRENT_USER,role:CURRENT_ROLE});showToast("Joined voice","success")}catch(e){showToast("Failed","error")}};';

        content += 'window.leaveVoice=function(){if(localStream){localStream.getTracks().forEach(function(t){t.stop()});localStream=null}if(screenStream){screenStream.getTracks().forEach(function(t){t.stop()});screenStream=null}Object.values(peerConnections).forEach(function(pc){try{pc.pc.close()}catch(e){}});peerConnections={};Object.keys(voiceStreams).forEach(function(k){delete voiceStreams[k]});document.querySelectorAll("audio[data-audio-for]").forEach(function(el){el.remove()});socket.emit("leave_voice");currentVoiceChannelId=null;isSharing=false;isMuted=false;isDeafened=false;viewingSocketId=null;document.getElementById("voicePanel").style.display="none";document.getElementById("voicePanel").classList.remove("fullscreen");document.body.style.overflow="";document.getElementById("voiceParticipantsStrip").innerHTML="";document.getElementById("voiceMainVideo").srcObject=null;document.getElementById("muteBtn").textContent="🎤";document.getElementById("shareBtn").textContent="🖥️";document.getElementById("shareBtn").style.background="";document.getElementById("deafBtn").textContent="🎧";document.getElementById("deafBtn").classList.remove("deafen-active");if(window._micTestStream){window._micTestStream.getTracks().forEach(function(t){t.stop()});window._micTestStream=null}if(micTestAudio){try{micTestAudio.disconnect()}catch(e){}micTestAudio=null}micTestActive=false;const mBtn=document.getElementById("micTestBtn");if(mBtn)mBtn.classList.remove("mic-test-active")};';

        content += 'window.toggleMute=function(){if(!localStream)return;isMuted=!isMuted;localStream.getAudioTracks().forEach(function(t){t.enabled=!isMuted});document.getElementById("muteBtn").textContent=isMuted?"🔇":"🎤";socket.emit("toggle_mute",{isMuted:isMuted})};';
        content += 'window.toggleDeafen=function(){isDeafened=!isDeafened;const btn=document.getElementById("deafBtn");btn.textContent=isDeafened?"🔇":"🎧";if(isDeafened)btn.classList.add("deafen-active");else btn.classList.remove("deafen-active");document.querySelectorAll("#voiceMainVideo, .voice-tile video, audio[data-audio-for]").forEach(function(v){v.muted=isDeafened});if(isDeafened&&!isMuted){isMuted=true;if(localStream)localStream.getAudioTracks().forEach(function(t){t.enabled=false});document.getElementById("muteBtn").textContent="🔇";socket.emit("toggle_mute",{isMuted:true})}showToast(isDeafened?"Deafened":"Undeafened","success")};';
        content += 'window.toggleMicTest=async function(){const btn=document.getElementById("micTestBtn");if(micTestActive){micTestActive=false;if(micTestAudio){try{micTestAudio.disconnect()}catch(e){}micTestAudio=null}if(window._micTestStream){window._micTestStream.getTracks().forEach(function(t){t.stop()});window._micTestStream=null}btn.classList.remove("mic-test-active");showToast("Mic test OFF","success");return}try{const testStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:true},video:false});window._micTestStream=testStream;const audioCtx=new(window.AudioContext||window.webkitAudioContext)();const source=audioCtx.createMediaStreamSource(testStream);const gainNode=audioCtx.createGain();gainNode.gain.value=1.5;source.connect(gainNode);gainNode.connect(audioCtx.destination);micTestAudio={audioCtx:audioCtx,source:source,gainNode:gainNode};micTestActive=true;btn.classList.add("mic-test-active");showToast("🎙️ Mic Test ON","success")}catch(e){showToast("Mic denied","error")}};';
        content += 'window.toggleFullscreenVoice=function(){const panel=document.getElementById("voicePanel");panel.classList.toggle("fullscreen");document.body.style.overflow=panel.classList.contains("fullscreen")?"hidden":""};';
        content += 'document.addEventListener("keydown",function(e){if(e.key==="Escape"){const p=document.getElementById("voicePanel");if(p&&p.classList.contains("fullscreen")){window.toggleFullscreenVoice()}}});';

        content += 'window.toggleShareScreen=async function(){if(!currentVoiceChannelId)return;if(isSharing){if(screenStream){screenStream.getTracks().forEach(function(t){t.stop()});screenStream=null}isSharing=false;document.getElementById("shareBtn").textContent="🖥️";document.getElementById("shareBtn").style.background="";if(viewingSocketId===null){document.getElementById("voiceMainVideo").srcObject=localStream;document.getElementById("voiceMainVideo").classList.remove("screen-mode");document.getElementById("voiceMainLabel").textContent="👤 You";document.getElementById("voiceMainLabel").classList.remove("live")}socket.emit("toggle_stream",{isStreaming:false});for(const entry of Object.entries(peerConnections)){const sid=entry[0];const pc=entry[1].pc;try{const s=pc.getSenders().find(function(s){return s.track&&s.track.kind==="video"});if(s)await s.replaceTrack(null);const offer=await pc.createOffer();await pc.setLocalDescription(offer);socket.emit("webrtc_offer",{targetSocketId:sid,offer:offer,isScreenShare:false})}catch(e){}}}else{try{screenStream=await navigator.mediaDevices.getDisplayMedia({video:{cursor:"always"},audio:false})}catch(e){return}isSharing=true;document.getElementById("shareBtn").textContent="⏹️";document.getElementById("shareBtn").style.background="linear-gradient(135deg,var(--red-1),var(--red-2))";if(viewingSocketId===null){document.getElementById("voiceMainVideo").srcObject=screenStream;document.getElementById("voiceMainVideo").classList.add("screen-mode");document.getElementById("voiceMainLabel").textContent="🖥️ Your Screen";document.getElementById("voiceMainLabel").classList.add("live")}socket.emit("toggle_stream",{isStreaming:true});screenStream.getVideoTracks()[0].onended=function(){if(isSharing)window.toggleShareScreen()};for(const entry of Object.entries(peerConnections)){const sid=entry[0];const pc=entry[1].pc;try{const vt=screenStream.getVideoTracks()[0];const s=pc.getSenders().find(function(s){return s.track&&s.track.kind==="video"});if(s)await s.replaceTrack(vt);else pc.addTrack(vt,screenStream);const offer=await pc.createOffer();await pc.setLocalDescription(offer);socket.emit("webrtc_offer",{targetSocketId:sid,offer:offer,isScreenShare:true})}catch(e){}}}};';

        content += 'window.minimizeVoice=function(){const v=document.querySelector(".voice-body");v.style.display=v.style.display==="none"?"flex":"none"};';

        content += 'function createPeerConnection(sid){if(peerConnections[sid])return peerConnections[sid].pc;const pc=new RTCPeerConnection(iceServers);if(localStream)localStream.getTracks().forEach(function(t){pc.addTrack(t,localStream)});if(screenStream)screenStream.getVideoTracks().forEach(function(t){pc.addTrack(t,screenStream)});pc.onicecandidate=function(e){if(e.candidate)socket.emit("webrtc_ice_candidate",{targetSocketId:sid,candidate:e.candidate})};pc.ontrack=function(e){const rs=e.streams[0];const isV=e.track.kind==="video";const meta=peerConnections[sid];const uname=meta&&meta.username?meta.username:"User";if(!voiceStreams[sid])voiceStreams[sid]={audio:null,video:null,username:uname,isStreaming:false,isMuted:false};if(isV){voiceStreams[sid].video=rs;voiceStreams[sid].isStreaming=true;if(viewingSocketId===sid)showFocusedUser(sid,uname);const tile=document.querySelector(\'.voice-tile[data-tile="\'+sid+\'"]\');if(tile){const sb=tile.querySelector(".voice-tile-stream-badge");if(sb)sb.style.display="block"}}else{voiceStreams[sid].audio=rs;let audioEl=document.querySelector(\'audio[data-audio-for="\'+sid+\'"]\');if(!audioEl){audioEl=document.createElement("audio");audioEl.dataset.audioFor=sid;audioEl.autoplay=true;audioEl.playsInline=true;document.body.appendChild(audioEl)}audioEl.srcObject=rs;audioEl.volume=1.0;audioEl.muted=isDeafened}};pc.onconnectionstatechange=function(){if(["disconnected","failed","closed"].indexOf(pc.connectionState)!==-1)removePeer(sid)};peerConnections[sid]={pc:pc,username:null,isOfferer:false};return pc}';

        content += 'function removePeer(sid){if(peerConnections[sid]){try{peerConnections[sid].pc.close()}catch(e){}delete peerConnections[sid]}delete voiceStreams[sid];const audioEl=document.querySelector(\'audio[data-audio-for="\'+sid+\'"]\');if(audioEl)audioEl.remove();const tile=document.querySelector(\'.voice-tile[data-tile="\'+sid+\'"]\');if(tile)tile.remove();if(viewingSocketId===sid)focusSelf()}';

        // renderSelfTile — NO template literals
        content += 'function renderSelfTile(){';
        content += 'const strip=document.getElementById("voiceParticipantsStrip");';
        content += 'let tile=document.querySelector(\'.voice-tile[data-tile="self"]\');';
        content += 'if(!tile){';
        content += 'tile=document.createElement("div");';
        content += 'tile.className="voice-tile";';
        content += 'tile.dataset.tile="self";';
        content += 'tile.onclick=function(){focusSelf()};';
        content += 'tile.innerHTML=\'<video autoplay playsinline muted></video><div class="voice-tile-avatar" style="display:none;">\'+escapeHtml(CURRENT_USER.charAt(0).toUpperCase())+\'</div><div class="voice-tile-label">You</div><div class="voice-tile-self-badge">YOU</div>\';';
        content += 'strip.insertBefore(tile,strip.firstChild);';
        content += '}';
        content += 'const v=tile.querySelector("video");';
        content += 'v.srcObject=isSharing?screenStream:localStream;';
        content += 'if(viewingSocketId===null)tile.classList.add("active-focus");';
        content += 'else tile.classList.remove("active-focus");';
        content += '}';

        // renderParticipantTile — NO template literals
        content += 'function renderParticipantTile(p){';
        content += 'const sid=p.socketId;';
        content += 'if(document.querySelector(\'.voice-tile[data-tile="\'+sid+\'"]\'))return;';
        content += 'const canKick=(IS_OWNER||IS_GLOBAL_ADMIN)&&p.username!==CURRENT_USER;';
        content += 'const tile=document.createElement("div");';
        content += 'tile.className="voice-tile";';
        content += 'tile.dataset.tile=sid;';
        content += 'tile.onclick=function(e){if(e.target.classList.contains("voice-tile-kick"))return;focusUser(sid,p.username)};';
        content += 'tile.innerHTML=\'<video autoplay playsinline muted></video><div class="voice-tile-avatar">\'+escapeHtml(p.username.charAt(0).toUpperCase())+\'</div><div class="voice-tile-stream-badge" style="display:\'+(p.isStreaming?"block":"none")+\'">● LIVE</div>\'+(p.isMuted?\'<div class="voice-tile-muted-badge">🔇</div>\':"")+\'<div class="voice-tile-label">\'+escapeHtml(p.username)+\'</div>\'+(canKick?\'<button class="voice-tile-kick" onclick="event.stopPropagation();kickFromVoice(\\\'\'+sid+\'\\\',\\\'\'+p.username.replace(/\'/g,"\\\\\'")+\'\\\')" title="Kick from voice">👢</button>\':"");';
        content += 'document.getElementById("voiceParticipantsStrip").appendChild(tile);';
        content += 'const vs=voiceStreams[sid];';
        content += 'if(vs&&vs.video){const v=tile.querySelector("video");v.srcObject=vs.video;const av=tile.querySelector(".voice-tile-avatar");if(av)av.style.display="none"}';
        content += '}';

        content += 'function updateParticipantTile(sid,p){const tile=document.querySelector(\'.voice-tile[data-tile="\'+sid+\'"]\');if(!tile)return;const sb=tile.querySelector(".voice-tile-stream-badge");if(sb)sb.style.display=p.isStreaming?"block":"none";const mb=tile.querySelector(".voice-tile-muted-badge");if(p.isMuted&&!mb){const nm=document.createElement("div");nm.className="voice-tile-muted-badge";nm.textContent="🔇";tile.appendChild(nm)}else if(!p.isMuted&&mb){mb.remove()}const vs=voiceStreams[sid];if(vs&&vs.video){const v=tile.querySelector("video");if(v&&!v.srcObject)v.srcObject=vs.video;const av=tile.querySelector(".voice-tile-avatar");if(av)av.style.display="none"}}';

        // showFocusedUser — NO template literals
        content += 'function showFocusedUser(sid,username){';
        content += 'const vs=voiceStreams[sid];';
        content += 'const mainVideo=document.getElementById("voiceMainVideo");';
        content += 'const mainLabel=document.getElementById("voiceMainLabel");';
        content += 'const mainBack=document.getElementById("voiceMainBack");';
        content += 'const mainAvatar=document.getElementById("voiceMainAvatar");';
        content += 'if(vs&&vs.video){';
        content += 'const combined=new MediaStream();';
        content += 'if(vs.audio)vs.audio.getAudioTracks().forEach(function(t){combined.addTrack(t)});';
        content += 'vs.video.getVideoTracks().forEach(function(t){combined.addTrack(t)});';
        content += 'mainVideo.srcObject=combined;';
        content += 'mainVideo.muted=isDeafened;';
        content += 'mainVideo.volume=1.0;';
        content += 'mainVideo.classList.add("screen-mode");';
        content += 'mainVideo.style.display="block";';
        content += 'mainAvatar.classList.remove("show");';
        content += 'mainLabel.textContent="🖥️ "+username+"\\\'s Screen";';
        content += 'mainLabel.classList.add("live");';
        content += 'mainBack.classList.add("show");';
        content += '}else{';
        content += 'mainVideo.srcObject=null;';
        content += 'mainVideo.style.display="none";';
        content += 'mainAvatar.classList.add("show");';
        content += 'document.getElementById("voiceMainAvatarCircle").textContent=username.charAt(0).toUpperCase();';
        content += 'document.getElementById("voiceMainAvatarName").textContent=username;';
        content += 'document.getElementById("voiceMainAvatarStatus").textContent="Not sharing screen";';
        content += 'mainLabel.textContent="👤 "+username;';
        content += 'mainLabel.classList.remove("live");';
        content += 'mainBack.classList.add("show");';
        content += '}';
        content += 'document.querySelectorAll(".voice-tile").forEach(function(t){t.classList.remove("active-focus")});';
        content += 'const tile=document.querySelector(\'.voice-tile[data-tile="\'+sid+\'"]\');';
        content += 'if(tile)tile.classList.add("active-focus");';
        content += '}';

        content += 'window.focusUser=function(sid,username){viewingSocketId=sid;showFocusedUser(sid,username);const vs=voiceStreams[sid];showToast(vs&&vs.video?"Watching "+username+"\\\'s screen":username+" is not sharing screen","success")};';
        content += 'window.focusSelf=function(){viewingSocketId=null;const mainVideo=document.getElementById("voiceMainVideo");const mainLabel=document.getElementById("voiceMainLabel");const mainBack=document.getElementById("voiceMainBack");const mainAvatar=document.getElementById("voiceMainAvatar");mainVideo.style.display="block";mainVideo.srcObject=isSharing?screenStream:localStream;mainVideo.muted=true;mainVideo.classList.toggle("screen-mode",isSharing);mainAvatar.classList.remove("show");mainLabel.textContent=isSharing?"🖥️ Your Screen":"👤 You";if(isSharing)mainLabel.classList.add("live");else mainLabel.classList.remove("live");mainBack.classList.remove("show");document.querySelectorAll(".voice-tile").forEach(function(t){t.classList.remove("active-focus")});const selfTile=document.querySelector(\'.voice-tile[data-tile="self"]\');if(selfTile)selfTile.classList.add("active-focus");showToast("Back to your view","success")};';

        content += 'socket.on("voice_participants",function(ps){document.querySelectorAll(".voice-participants").forEach(function(el){el.innerHTML=""});document.querySelectorAll(".voice-count").forEach(function(el){el.textContent="0";el.style.display="none"});ps.forEach(function(p){const c=document.getElementById("voice-participants-"+currentVoiceChannelId);if(c){const canKick=(IS_OWNER||IS_GLOBAL_ADMIN)&&p.username!==CURRENT_USER;const d=document.createElement("div");d.className="voice-user";d.innerHTML=\'<div class="voice-user-avatar">\'+escapeHtml(p.username.charAt(0).toUpperCase())+\'</div><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\'+escapeHtml(p.username)+(p.isMuted?" 🔇":"")+(p.isStreaming?" 🖥️":"")+\'</span>\'+(canKick?\'<button class="channel-icon-btn" style="opacity:0.6;" onclick="event.stopPropagation();kickFromVoice(\\\'\'+p.socketId+\'\\\',\\\'\'+p.username.replace(/\'/g,"\\\\\'")+\'\\\')" title="Kick from voice">👢</button>\':"");c.appendChild(d)}});const cnt=document.getElementById("voice-count-"+currentVoiceChannelId);if(cnt){cnt.textContent=ps.length;cnt.style.display=ps.length>0?"inline-block":"none"}renderSelfTile();const others=ps.filter(function(p){return p.socketId!==socket.id});document.querySelectorAll(".voice-tile").forEach(function(t){if(t.dataset.tile==="self")return;if(!others.find(function(p){return p.socketId===t.dataset.tile}))t.remove()});others.forEach(function(p){if(document.querySelector(\'.voice-tile[data-tile="\'+p.socketId+\'"]\'))updateParticipantTile(p.socketId,p);else renderParticipantTile(p)});if(viewingSocketId){const vp=ps.find(function(p){return p.socketId===viewingSocketId});if(!vp){focusSelf()}else showFocusedUser(viewingSocketId,vp.username)}});';

        content += 'window.kickFromVoice=function(targetSocketId,username){if(!confirm("Kick "+(username||"this user")+" from voice?"))return;socket.emit("kick_from_voice",{targetSocketId:targetSocketId,kickedBy:CURRENT_USER})};';
        content += 'socket.on("you_were_kicked",function(d){showToast("You were kicked from voice by "+d.by,"error");window.leaveVoice()});';

        content += 'socket.on("voice_existing_users",async function(d){for(const u of d.users){try{const pc=createPeerConnection(u.socketId);peerConnections[u.socketId].username=u.username;peerConnections[u.socketId].isOfferer=true;const offer=await pc.createOffer();await pc.setLocalDescription(offer);socket.emit("webrtc_offer",{targetSocketId:u.socketId,offer:offer,isScreenShare:false})}catch(e){}}});';
        content += 'socket.on("webrtc_offer",async function(d){try{const pc=createPeerConnection(d.fromSocketId);peerConnections[d.fromSocketId].username=d.fromUsername;await pc.setRemoteDescription(new RTCSessionDescription(d.offer));const answer=await pc.createAnswer();await pc.setLocalDescription(answer);socket.emit("webrtc_answer",{targetSocketId:d.fromSocketId,answer:answer})}catch(e){}});';
        content += 'socket.on("webrtc_answer",async function(d){try{const p=peerConnections[d.fromSocketId];if(p&&p.pc.signalingState!=="stable")await p.pc.setRemoteDescription(new RTCSessionDescription(d.answer))}catch(e){}});';
        content += 'socket.on("webrtc_ice_candidate",async function(d){try{const p=peerConnections[d.fromSocketId];if(p&&d.candidate)await p.pc.addIceCandidate(new RTCIceCandidate(d.candidate))}catch(e){}});';
        content += 'socket.on("user_left_voice",function(d){removePeer(d.socketId)});';

        content += 'const firstText=document.querySelector(".channel-item");';
        content += 'if(firstText){const fid=parseInt(firstText.dataset.id);switchChannel(fid,firstText.querySelector(".channel-name").textContent,firstText.dataset.visibility||"public","","text")}';

        content += '</script>';
        content += '<style>@keyframes msgIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}</style>';

        res.send(renderLayout({ title: srv.name, pageTitle: srv.name, pageSubtitle: membersR.rows.length + ' members', content: content, user: req.session.user, activeNav: 'servers' }));
    } catch (e) { console.error(e); res.status(500).send('Error: ' + e.message); }
});

function renderChannelItem(c, me, isOwner, isGlobalAdmin) {
    const canEdit = isOwner || isGlobalAdmin || c.created_by === me;
    let icons = '';
    if (canEdit) {
        icons = '<div class="channel-icons"><button class="channel-icon-btn" onclick="event.stopPropagation();openRename(' + c.id + ', \'' + c.name.replace(/'/g, "\\'") + '\')" title="Rename">✏️</button></div>';
    }
    let badges = '';
    if (c.visibility === 'private') badges = '<span class="badge badge-private" style="font-size:8px;padding:1px 5px;">🔒</span>';
    if (c.visibility === 'personal') badges = '<span class="badge badge-personal" style="font-size:8px;padding:1px 5px;">👑</span>';
    return '<div class="channel-item" data-id="' + c.id + '" data-name="' + c.name.replace(/"/g, '&quot;') + '" data-visibility="' + (c.visibility || 'public') + '" onclick="switchChannel(' + c.id + ', \'' + c.name.replace(/'/g, "\\'") + '\', \'' + (c.visibility || 'public') + '\', \'' + c.created_by + '\', \'text\')">' +
        '<span class="channel-hash">#</span>' +
        '<span class="channel-name">' + c.name + '</span>' +
        badges +
        icons +
    '</div>';
}

function renderVoiceChannelItem(c, me, isOwner, isGlobalAdmin) {
    return '<div class="voice-channel-item" data-id="' + c.id + '" data-name="' + c.name.replace(/"/g, '&quot;') + '">' +
        '<div class="voice-item-header">' +
            '<span>🔊</span>' +
            '<span class="voice-name">' + c.name + '</span>' +
            '<span class="voice-count" id="voice-count-' + c.id + '" style="display:none;">0</span>' +
        '</div>' +
        '<div class="voice-participants" id="voice-participants-' + c.id + '"></div>' +
        '<button class="voice-join-btn" onclick="joinVoice(' + c.id + ', \'' + c.name.replace(/'/g, "\\'") + '\')">Join</button>' +
    '</div>';
}

// ==================== FRIENDS ====================
app.get('/friends', requireLogin, function(req, res) {
    const content = '<div class="card"><h3 style="margin-bottom:14px;">Friends</h3><p style="color:var(--text-2);">Friends system ready. Use chat to talk with other users.</p><a href="/servers" class="btn btn-primary" style="margin-top:14px;">Go to Servers</a></div>';
    res.send(renderLayout({ title: 'Friends', pageTitle: 'Friends', pageSubtitle: 'Manage your friends', content: content, user: req.session.user, activeNav: 'friends' }));
});

// ==================== ADMIN ====================
app.get('/admin', requireLogin, requireAdmin, async function(req, res) {
    try {
        const u = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
        let rows = '';
        u.rows.forEach(function(x) { const isA = x.role === 'ADMIN'; rows += '<a href="/admin/user/' + encodeURIComponent(x.username) + '" class="card" style="display:flex;align-items:center;gap:14px;margin-bottom:10px;cursor:pointer;text-decoration:none;"><div class="user-avatar ' + (isA ? 'user-avatar-admin' : '') + '">' + x.username.charAt(0) + '</div><div style="flex:1;"><div style="font-weight:700;">' + x.username + ' <span class="badge ' + (isA ? 'badge-admin' : 'badge-user') + '">' + x.role + '</span></div><div style="font-size:12px;color:var(--text-2);">Joined ' + new Date(x.created_at).toLocaleDateString() + '</div></div><span class="btn btn-ghost btn-sm">View</span></a>'; });
        const content = rows || '<div class="empty"><div class="empty-icon">◉</div><div class="empty-title">No users</div></div>';
        res.send(renderLayout({ title: 'Admin', pageTitle: 'Admin Panel', pageSubtitle: u.rows.length + ' users', content: content, user: req.session.user, activeNav: 'admin' }));
    } catch (e) { res.status(500).send('Error'); }
});
app.get('/admin/user/:username', requireLogin, requireAdmin, async function(req, res) {
    try { const t = req.params.username; const s = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [t]); const content = s.rows.length === 0 ? '<div class="empty"><div class="empty-icon">◈</div><div class="empty-title">No scripts</div></div>' : '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;">' + s.rows.map(renderScriptCard).join('') + '</div>'; res.send(renderLayout({ title: t, pageTitle: t + '\'s Scripts', pageSubtitle: s.rows.length + ' scripts', content: content, user: req.session.user, activeNav: 'admin', actions: '<a href="/admin" class="btn btn-ghost">← All Users</a>' })); } catch (e) { res.status(500).send('Error'); }
});

// ==================== SOCKET.IO ====================
const voiceRooms = new Map();

io.on('connection', function(socket) {
    console.log('🔗 Connected:', socket.id);

    socket.on('register_user', function(d) { socket.username = d.username; });

    socket.on('join_chat', async function(data) {
        try {
            const channelId = data.channelId;
            socket.channelId = channelId;
            socket.join('channel_' + channelId);
            const r = await pool.query('SELECT * FROM chat_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 50', [channelId]);
            socket.emit('chat_history', r.rows.reverse());
        } catch (e) { console.error(e); }
    });

    socket.on('switch_channel', async function(data) {
        try {
            const channelId = data.channelId;
            if (socket.channelId) socket.leave('channel_' + socket.channelId);
            socket.channelId = channelId;
            socket.join('channel_' + channelId);
            const r = await pool.query('SELECT * FROM chat_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 50', [channelId]);
            socket.emit('chat_history', r.rows.reverse());
        } catch (e) { console.error(e); }
    });

    socket.on('send_message', async function(data) {
        try {
            const username = data.username;
            const role = data.role;
            const message = data.message;
            const channelId = data.channelId;
            if (!message || !message.trim()) return;
            const chk = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
            if (chk.rows.length === 0) return;
            const ch = chk.rows[0];
            const isAdmin = role === 'ADMIN';
            if (ch.read_only && !isAdmin && ch.created_by !== username) return;
            const r = await pool.query('INSERT INTO chat_messages (channel_id, username, role, message) VALUES ($1, $2, $3, $4) RETURNING *', [channelId, username, role, message.trim().substring(0, 500)]);
            io.to('channel_' + channelId).emit('new_message', r.rows[0]);
        } catch (e) { console.error(e); }
    });

    socket.on('delete_message', async function(data) {
        try {
            const messageId = data.messageId;
            const role = data.role;
            const channelId = data.channelId;
            if (role !== 'ADMIN') return;
            await pool.query('DELETE FROM chat_messages WHERE id = $1', [messageId]);
            io.to('channel_' + channelId).emit('message_deleted', { messageId: messageId });
        } catch (e) { console.error(e); }
    });

    socket.on('join_voice', async function(data) {
        try {
            const voiceChannelId = data.voiceChannelId;
            const username = data.username;
            const role = data.role;
            if (socket.voiceChannelId) {
                socket.leave('voice_' + socket.voiceChannelId);
                const pr = voiceRooms.get(socket.voiceChannelId);
                if (pr) {
                    pr.delete(socket.id);
                    if (pr.size === 0) voiceRooms.delete(socket.voiceChannelId);
                    else io.to('voice_' + socket.voiceChannelId).emit('voice_participants', Array.from(pr.values()));
                }
            }
            socket.voiceChannelId = voiceChannelId;
            socket.voiceUsername = username;
            socket.join('voice_' + voiceChannelId);
            if (!voiceRooms.has(voiceChannelId)) voiceRooms.set(voiceChannelId, new Map());
            voiceRooms.get(voiceChannelId).set(socket.id, { socketId: socket.id, username: username, role: role, isStreaming: false, isMuted: false });
            const ps = Array.from(voiceRooms.get(voiceChannelId).values());
            io.to('voice_' + voiceChannelId).emit('voice_participants', ps);
            socket.emit('voice_existing_users', { users: ps.filter(function(p) { return p.socketId !== socket.id; }), self: socket.id });
        } catch (e) { console.error(e); }
    });

    socket.on('leave_voice', function() {
        if (!socket.voiceChannelId) return;
        const vcId = socket.voiceChannelId;
        const r = voiceRooms.get(vcId);
        if (r) {
            r.delete(socket.id);
            if (r.size === 0) voiceRooms.delete(vcId);
            else io.to('voice_' + vcId).emit('voice_participants', Array.from(r.values()));
        }
        socket.to('voice_' + vcId).emit('user_left_voice', { socketId: socket.id });
        socket.leave('voice_' + vcId);
        socket.voiceChannelId = null;
        socket.voiceUsername = null;
    });

    socket.on('kick_from_voice', function(data) {
        const targetSocketId = data.targetSocketId;
        const kickedBy = data.kickedBy;
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (!targetSocket) return;
        if (!socket.voiceChannelId) return;
        const r = voiceRooms.get(socket.voiceChannelId);
        if (!r || !r.has(socket.id)) return;
        const kicker = r.get(socket.id);
        const target = r.get(targetSocketId);
        if (!target) return;
        const canKick = ['OWNER', 'ADMIN'].indexOf(kicker.role) !== -1;
        if (!canKick) return;
        targetSocket.emit('you_were_kicked', { by: kickedBy, from: socket.voiceChannelId });
        if (targetSocket.voiceChannelId) {
            const tVcId = targetSocket.voiceChannelId;
            const tR = voiceRooms.get(tVcId);
            if (tR) {
                tR.delete(targetSocketId);
                if (tR.size === 0) voiceRooms.delete(tVcId);
                else io.to('voice_' + tVcId).emit('voice_participants', Array.from(tR.values()));
            }
            targetSocket.to('voice_' + tVcId).emit('user_left_voice', { socketId: targetSocketId });
            targetSocket.leave('voice_' + tVcId);
            targetSocket.voiceChannelId = null;
        }
    });

    socket.on('webrtc_offer', function(d) {
        io.to(d.targetSocketId).emit('webrtc_offer', { fromSocketId: socket.id, fromUsername: socket.voiceUsername, offer: d.offer, isScreenShare: d.isScreenShare });
    });
    socket.on('webrtc_answer', function(d) {
        io.to(d.targetSocketId).emit('webrtc_answer', { fromSocketId: socket.id, answer: d.answer });
    });
    socket.on('webrtc_ice_candidate', function(d) {
        io.to(d.targetSocketId).emit('webrtc_ice_candidate', { fromSocketId: socket.id, candidate: d.candidate });
    });
    socket.on('toggle_mute', function(d) {
        if (!socket.voiceChannelId) return;
        const r = voiceRooms.get(socket.voiceChannelId);
        if (r && r.has(socket.id)) {
            r.get(socket.id).isMuted = d.isMuted;
            io.to('voice_' + socket.voiceChannelId).emit('voice_participants', Array.from(r.values()));
        }
    });
    socket.on('toggle_stream', function(d) {
        if (!socket.voiceChannelId) return;
        const r = voiceRooms.get(socket.voiceChannelId);
        if (r && r.has(socket.id)) {
            r.get(socket.id).isStreaming = d.isStreaming;
            io.to('voice_' + socket.voiceChannelId).emit('voice_participants', Array.from(r.values()));
        }
    });

    socket.on('disconnect', function() {
        if (socket.voiceChannelId) {
            const vcId = socket.voiceChannelId;
            const r = voiceRooms.get(vcId);
            if (r) {
                r.delete(socket.id);
                if (r.size === 0) voiceRooms.delete(vcId);
                else io.to('voice_' + vcId).emit('voice_participants', Array.from(r.values()));
            }
            socket.to('voice_' + vcId).emit('user_left_voice', { socketId: socket.id });
        }
        console.log('❌ Disconnected:', socket.id);
    });
});

// ==================== START ====================
server.listen(PORT, function() {
    console.log('✅ ' + BRAND_NAME + ' v39.1 — Syntax Fixed');
    console.log('👤 Default: sarili mo lang ang nakikita mo');
    console.log('👆 Click user → papalitan ng screen nila');
    console.log('👆 Click "You" → babalik sa sarili mo');
    console.log('👢 Kick: server + voice (Owner/Admin)');
});
