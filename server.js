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
if (!DATABASE_URL) { console.error('❌ DATABASE_URL is not set!'); process.exit(1); }

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==================== DATABASE INIT ====================
async function initDB() {
    try {
        // Base tables
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role VARCHAR(20) DEFAULT 'USER', display_name VARCHAR(50), tag VARCHAR(4), bio VARCHAR(200) DEFAULT '', created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS scripts (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(100) NOT NULL DEFAULT 'Script', version VARCHAR(50) NOT NULL DEFAULT 'V1', real_content TEXT NOT NULL, public_content TEXT NOT NULL, token VARCHAR(64) UNIQUE NOT NULL, owner VARCHAR(50) NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS "session" ("sid" VARCHAR NOT NULL COLLATE "default", "sess" JSON NOT NULL, "expire" TIMESTAMP(6) NOT NULL, CONSTRAINT "session_pkey" PRIMARY KEY ("sid"));`);

        // Servers (Discord-style)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS servers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                owner VARCHAR(50) NOT NULL,
                invite_code VARCHAR(16) UNIQUE NOT NULL,
                icon VARCHAR(10) DEFAULT '🎮',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS server_members (
                id SERIAL PRIMARY KEY,
                server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                role VARCHAR(20) DEFAULT 'MEMBER',
                joined_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(server_id, username)
            );
        `);

        // Channels
        await pool.query(`
            CREATE TABLE IF NOT EXISTS channels (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                description VARCHAR(200) DEFAULT '',
                created_by VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // Chat messages
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id SERIAL PRIMARY KEY,
                channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                role VARCHAR(20) DEFAULT 'USER',
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // Friends
        await pool.query(`CREATE TABLE IF NOT EXISTS friends (id SERIAL PRIMARY KEY, user1 VARCHAR(50) NOT NULL, user2 VARCHAR(50) NOT NULL, status VARCHAR(20) DEFAULT 'pending', requested_by VARCHAR(50) NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user1, user2));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS dm_messages (id SERIAL PRIMARY KEY, from_user VARCHAR(50) NOT NULL, to_user VARCHAR(50) NOT NULL, message TEXT NOT NULL, read BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW());`);

        // Migrations - add missing columns
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(50);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tag VARCHAR(4);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200) DEFAULT '';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS slug VARCHAR(100) DEFAULT 'Script';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS version VARCHAR(50) DEFAULT 'V1';`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;`);
        await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS type VARCHAR(10) DEFAULT 'text';`);
        await pool.query(`UPDATE scripts SET slug = LOWER(REPLACE(name, ' ', '_')) WHERE slug = 'Script' OR slug IS NULL;`);
        await pool.query(`UPDATE scripts SET version = 'V1' WHERE version IS NULL;`);

        // Remove old UNIQUE constraint on channels.name (kasi may multiple servers na ngayon)
        try { await pool.query(`ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_name_key;`); } catch(e) {}

        // Generate tags
        const noTag = await pool.query(`SELECT id FROM users WHERE tag IS NULL`);
        for (const u of noTag.rows) {
            const tag = Math.floor(1000 + Math.random() * 9000).toString();
            await pool.query(`UPDATE users SET tag = $1, display_name = username WHERE id = $2`, [tag, u.id]);
        }

        // Create default server if none
        const srvCheck = await pool.query('SELECT * FROM servers LIMIT 1');
        let defaultServerId = null;
        if (srvCheck.rows.length === 0) {
            const invite = crypto.randomBytes(6).toString('hex');
            const newServer = await pool.query(
                'INSERT INTO servers (name, owner, invite_code, icon) VALUES ($1, $2, $3, $4) RETURNING *',
                ['Zyrox-Kido', 'system', invite, '⭐']
            );
            defaultServerId = newServer.rows[0].id;
            console.log('🌟 Default server created');
        } else {
            defaultServerId = srvCheck.rows[0].id;
        }

        // Ensure channels exist for default server
        const chanCheck = await pool.query('SELECT * FROM channels WHERE server_id = $1', [defaultServerId]);
        if (chanCheck.rows.length === 0) {
            await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4)', [defaultServerId, 'general', 'text', 'system']);
            await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4)', [defaultServerId, 'welcome', 'text', 'system']);
            await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4)', [defaultServerId, 'Lounge', 'voice', 'system']);
            console.log('💬 Default channels created');
        }

        // Assign orphan channels to default server
        await pool.query(`UPDATE channels SET server_id = $1 WHERE server_id IS NULL`, [defaultServerId]);

        console.log('✅ DB ready');

        const adminPass = process.env.ADMIN_PASSWORD;
        if (adminPass) {
            const ex = await pool.query('SELECT * FROM users WHERE username = $1', ['Z-K']);
            if (ex.rows.length === 0) {
                const tag = Math.floor(1000 + Math.random() * 9000).toString();
                await pool.query('INSERT INTO users (username, password, role, display_name, tag) VALUES ($1, $2, $3, $4, $5)', ['Z-K', adminPass, 'ADMIN', 'Z-K', tag]);
                console.log('👑 Admin created');
            }
        }
    } catch (e) { console.error('❌ DB Init error:', e.message); }
}
initDB();

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'zyrox-kido-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

function requireLogin(req, res, next) { if (req.session.user) next(); else res.redirect('/login'); }
function requireAdmin(req, res, next) { if (req.session.user && req.session.user.role === 'ADMIN') next(); else res.status(403).send('Access Denied'); }

const BRAND_NAME = 'By Zyrox-Kido';
const BRAND_SHORT = 'Zyrox-Kido';

// ==================== LOGO ====================
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#ff3b3b"/><stop offset="100%" style="stop-color:#cc0000"/></linearGradient></defs><path d="M50 5 L85 20 L85 50 C85 75 70 90 50 95 C30 90 15 75 15 50 L15 20 Z" fill="url(#g)" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/><text x="50" y="62" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#fff" text-anchor="middle">ZK</text></svg>`;
app.get('/logo.svg', (req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.send(LOGO_SVG); });
app.get('/favicon.svg', (req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.send(LOGO_SVG); });
app.get('/favicon.ico', (req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.send(LOGO_SVG); });

// ==================== OBFUSCATION ====================
function obfuscateScript(code) {
    const encoded = Buffer.from(code, 'utf8').toString('base64');
    return `local _b64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local _d="${encoded}"
local _o={}
for _c in _d:gmatch(".") do local _n=_b64:find(_c,1,true) if _n then _o[#_o+1]=_n-1 end end
local _r=""
for _i=1,#_o,4 do
local _a=_o[_i] or 0
local _b=_o[_i+1] or 0
local _c=_o[_i+2] or 0
local _d2=_o[_i+3] or 0
local _n=_a*262144+_b*4096+_c*64+_d2
_r=_r..string.char(math.floor(_n/65536)%256)
if _c then _r=_r..string.char(math.floor(_n/256)%256) end
if _d2 then _r=_r..string.char(_n%256) end
end
local _f=loadstring(_r)
if _f then _f() end`;
}
function makeSlug(name) { return name.toString().trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50) || 'Script'; }
function versionDropdown(selectedValue) {
    let options = '';
    for (let i = 1; i <= 1000; i++) { const v = 'V' + i; options += `<option value="${v}" ${v === selectedValue ? 'selected' : ''}>${v}</option>`; }
    return options;
}
function getHtmlHead(title) {
    return `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#0a0505"><title>${title} · ${BRAND_SHORT}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">`;
}

// ==================== STYLES ====================
const LAYOUT_STYLES = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg-0:#0a0505;--bg-1:#0f0808;--bg-2:#150a0a;--bg-3:#1c0d0d;--border-0:#2a1414;--border-1:#3a1a1a;--border-2:#4d2020;--text-0:#fff;--text-1:#d4d4d4;--text-2:#8a8a8a;--text-3:#5a5a5a;--accent:#ff3b3b;--accent-bright:#ff5555;--accent-dim:rgba(255,59,59,0.1);--accent-glow:rgba(255,59,59,0.5);--red-1:#ff3b3b;--red-2:#cc0000;--orange:#ff8c42;--purple:#b855ff;--blue:#4a9eff}
html,body{height:100%}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg-0);color:var(--text-0);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;overflow-x:hidden;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 900px 700px at 15% -10%,rgba(255,59,59,0.15) 0%,transparent 55%),radial-gradient(ellipse 900px 700px at 85% 110%,rgba(184,85,255,0.08) 0%,transparent 55%);pointer-events:none;z-index:0}
a{color:inherit;text-decoration:none}button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}input,textarea,select,button{-webkit-appearance:none;appearance:none}
.layout{display:flex;min-height:100vh;position:relative;z-index:1}
.sidebar{width:264px;background:rgba(15,8,8,0.7);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-right:1px solid var(--border-0);padding:20px 14px;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50;transition:transform 0.35s cubic-bezier(0.4,0,0.2,1);padding-top:max(20px,env(safe-area-inset-top))}
.sidebar-brand{display:flex;align-items:center;gap:11px;padding:6px 10px 18px 10px;border-bottom:1px solid var(--border-0);margin-bottom:16px}
.sidebar-logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px;color:#fff;box-shadow:0 4px 24px var(--accent-glow)}
.sidebar-brand-text{display:flex;flex-direction:column;min-width:0}
.sidebar-brand-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:var(--text-0)}
.sidebar-brand-sub{font-size:10px;color:var(--text-3);font-weight:700;letter-spacing:0.8px;text-transform:uppercase;margin-top:2px}
.sidebar-nav{display:flex;flex-direction:column;gap:2px;flex:1;overflow-y:auto}
.nav-section-label{font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:1.2px;padding:14px 12px 6px 12px}
.nav-item{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:10px;font-size:14px;font-weight:600;color:var(--text-1);transition:all 0.2s;cursor:pointer;position:relative;min-height:44px}
.nav-item:hover{background:var(--bg-2);color:var(--text-0)}
.nav-item.active{background:var(--accent-dim);color:var(--accent)}
.nav-item.active::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:22px;background:linear-gradient(180deg,var(--red-1),var(--red-2));border-radius:0 4px 4px 0;box-shadow:0 0 12px var(--accent-glow)}
.nav-icon{width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.sidebar-footer{padding-top:14px;border-top:1px solid var(--border-0)}
.user-card{display:flex;align-items:center;gap:10px;padding:10px;border-radius:11px;background:var(--bg-2);border:1px solid transparent;min-height:52px}
.user-card:hover{background:var(--bg-3);border-color:var(--border-1)}
.user-avatar{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex-shrink:0;box-shadow:0 2px 12px var(--accent-glow)}
.user-avatar-admin{background:linear-gradient(135deg,#ffaa00,#ff6600);box-shadow:0 2px 12px rgba(255,170,0,0.5)}
.user-meta{display:flex;flex-direction:column;min-width:0;flex:1}
.user-name{font-size:13.5px;font-weight:700;color:var(--text-0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-role{font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:0.6px}
.main{flex:1;margin-left:264px;min-height:100vh;display:flex;flex-direction:column;width:100%}
.topbar{height:64px;background:rgba(10,5,5,0.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border-0);padding:0 28px;display:flex;align-items:center;justify-content:space-between;gap:20px;position:sticky;top:0;z-index:40}
.topbar-left{display:flex;align-items:center;gap:14px;min-width:0;flex:1}
.topbar-title{font-size:15px;font-weight:700;color:var(--text-0);font-family:'Space Grotesk',sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.icon-btn{width:40px;height:40px;border-radius:11px;background:var(--bg-2);border:1px solid var(--border-0);display:flex;align-items:center;justify-content:center;color:var(--text-1);font-size:15px;flex-shrink:0}
.icon-btn:hover{background:var(--bg-3);color:var(--accent);border-color:var(--border-1)}
.content{padding:32px;padding-bottom:calc(32px + env(safe-area-inset-bottom));flex:1;max-width:1440px;width:100%;margin:0 auto}
.page-header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:32px}
.page-title{font-family:'Space Grotesk',sans-serif;font-size:32px;font-weight:700;color:var(--text-0);letter-spacing:-1.2px;margin-bottom:6px;line-height:1.1;background:linear-gradient(135deg,#fff 0%,#ff5555 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.page-subtitle{font-size:13.5px;color:var(--text-2);font-weight:500}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:11px;font-weight:700;font-size:13px;transition:all 0.2s;cursor:pointer;white-space:nowrap;text-decoration:none;border:1px solid transparent;min-height:42px}
.btn:active{transform:scale(0.97)}
.btn-primary{background:linear-gradient(135deg,var(--red-1),var(--red-2));color:#fff;box-shadow:0 4px 20px rgba(255,59,59,0.3)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(255,59,59,0.5)}
.btn-secondary{background:var(--bg-2);color:var(--text-0);border-color:var(--border-1)}
.btn-secondary:hover{background:var(--bg-3);border-color:var(--border-2);transform:translateY(-2px)}
.btn-danger{background:rgba(255,59,59,0.08);color:#ff5555;border-color:rgba(255,59,59,0.2)}
.btn-danger:hover{background:rgba(255,59,59,0.15);border-color:rgba(255,59,59,0.4)}
.btn-ghost{background:transparent;color:var(--text-1);border-color:var(--border-1)}
.btn-ghost:hover{background:var(--bg-2);color:var(--text-0);border-color:var(--border-2)}
.btn-sm{padding:9px 14px;font-size:12.5px;border-radius:9px;min-height:38px}
.btn-block{width:100%}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:32px}
.stat{position:relative;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:16px;padding:20px 22px}
.stat::before{content:'';position:absolute;top:0;left:0;width:100%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,59,59,0.4),transparent)}
.stat:hover{border-color:var(--border-1);transform:translateY(-2px)}
.stat-icon{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,var(--red-1),var(--red-2));color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:16px;box-shadow:0 6px 20px rgba(255,59,59,0.3)}
.stat-label{font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:6px}
.stat-value{font-family:'Space Grotesk',sans-serif;font-size:30px;font-weight:700;color:var(--text-0);letter-spacing:-1.2px;line-height:1.1}
.stat-value-sm{font-size:22px}
.scripts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.script-card{position:relative;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:14px}
.script-card::before{content:'';position:absolute;top:0;left:0;width:100%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,59,59,0.4),transparent)}
.script-card:hover{border-color:var(--border-1);background:linear-gradient(180deg,var(--bg-2),var(--bg-1));transform:translateY(-3px)}
.script-card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.script-card-icon{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0;box-shadow:0 6px 20px rgba(255,59,59,0.3)}
.script-card-info{flex:1;min-width:0;padding-top:2px}
.script-card-name{font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:700;color:var(--text-0);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.script-card-meta{font-size:11.5px;color:var(--text-2);font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:7px;font-size:10px;font-weight:800;letter-spacing:0.4px;border:1px solid transparent}
.badge-version{background:rgba(184,85,255,0.12);color:#c490ff;border-color:rgba(184,85,255,0.25)}
.badge-admin{background:rgba(255,170,0,0.12);color:#ffbb44;border-color:rgba(255,170,0,0.25)}
.badge-user{background:var(--accent-dim);color:var(--accent-bright);border-color:rgba(255,59,59,0.25)}
.badge-owner{background:rgba(74,158,255,0.12);color:#7cc0ff;border-color:rgba(74,158,255,0.25)}
.script-card-url{background:var(--bg-0);border:1px solid var(--border-0);border-radius:10px;padding:12px 14px;font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--accent-bright);word-break:break-all;line-height:1.6}
.script-card-actions{display:flex;gap:8px;flex-wrap:wrap;padding-top:6px}
.script-card-actions .btn{flex:1;min-width:calc(50% - 5px)}
.empty{background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px dashed var(--border-1);border-radius:16px;padding:70px 30px;text-align:center}
.empty-icon{width:76px;height:76px;border-radius:20px;background:var(--bg-2);border:1px solid var(--border-0);display:flex;align-items:center;justify-content:center;font-size:34px;margin:0 auto 20px}
.empty-title{font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:700;color:var(--text-0);margin-bottom:8px}
.empty-desc{font-size:13.5px;color:var(--text-2);margin-bottom:24px}
.card{position:relative;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:16px;padding:30px}
.card::before{content:'';position:absolute;top:0;left:0;width:100%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,59,59,0.4),transparent)}
.form-group{margin-bottom:20px}
.form-label{display:block;font-size:12px;font-weight:700;color:var(--text-1);margin-bottom:9px;letter-spacing:0.4px;text-transform:uppercase}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px}
input,textarea,select{width:100%;padding:13px 15px;background:var(--bg-0);border:1px solid var(--border-0);border-radius:11px;color:var(--text-0);font-size:15px;font-family:inherit;outline:none;min-height:48px}
input:focus,textarea:focus,select:focus{border-color:var(--accent);background:var(--bg-1);box-shadow:0 0 0 3px var(--accent-dim)}
input::placeholder,textarea::placeholder{color:var(--text-3)}
textarea{font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.65;resize:vertical;min-height:300px}
select{cursor:pointer;background-image:url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a8a8a' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'/%3e%3c/svg%3e");background-repeat:no-repeat;background-position:right 14px center;background-size:16px;padding-right:42px}
.user-row{position:relative;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:14px;padding:16px 20px;display:flex;align-items:center;gap:14px;margin-bottom:10px}
.user-row:hover{border-color:var(--border-1);background:linear-gradient(180deg,var(--bg-2),var(--bg-1));transform:translateX(3px)}
.user-row .user-avatar{width:44px;height:44px;border-radius:12px;font-size:17px}
.user-row-info{flex:1;min-width:0}
.user-row-name{font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:700;color:var(--text-0);display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.user-row-meta{font-size:12px;color:var(--text-2);font-weight:500}
@keyframes toastIn{from{transform:translateX(400px) scale(0.9);opacity:0}to{transform:translateX(0) scale(1);opacity:1}}
@keyframes toastOut{to{transform:translateX(400px) scale(0.9);opacity:0}}
.toast{position:fixed;bottom:calc(24px + env(safe-area-inset-bottom));right:24px;background:var(--bg-2);border:1px solid var(--border-1);color:var(--text-0);padding:14px 20px;border-radius:12px;font-weight:600;font-size:13.5px;box-shadow:0 24px 60px rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;gap:12px;animation:toastIn 0.35s cubic-bezier(0.34,1.56,0.64,1);max-width:90vw}
.toast.hiding{animation:toastOut 0.3s ease forwards}
.toast::before{content:'';width:10px;height:10px;border-radius:50%;flex-shrink:0}
.toast.success::before{background:var(--red-1);box-shadow:0 0 16px var(--accent-glow)}
.toast.error::before{background:#ffb800;box-shadow:0 0 16px rgba(255,184,0,0.5)}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{position:relative;background:rgba(15,8,8,0.7);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);border:1px solid var(--border-1);border-radius:22px;padding:44px 40px;width:420px;max-width:100%;box-shadow:0 40px 100px rgba(0,0,0,0.7)}
.login-card::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:60%;height:1px;background:linear-gradient(90deg,transparent,var(--red-1),transparent);opacity:0.8}
.login-brand{display:flex;flex-direction:column;align-items:center;margin-bottom:32px;text-align:center}
.login-logo{width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:28px;color:#fff;margin-bottom:18px;box-shadow:0 16px 48px var(--accent-glow)}
.login-title{font-family:'Space Grotesk',sans-serif;font-size:26px;font-weight:700;color:var(--text-0);margin-bottom:6px}
.login-sub{font-size:13.5px;color:var(--text-2);font-weight:500}
.login-card input{margin-bottom:13px;padding:14px 16px}
.login-card .btn-primary{width:100%;padding:15px;font-size:14.5px;margin-top:8px}
.login-msg{margin-top:16px;text-align:center;font-size:12.5px;font-weight:600;min-height:18px}
.login-msg.error{color:#ff5555}
.login-msg.success{color:#22c55e}
.login-link{display:block;text-align:center;margin-top:22px;font-size:13.5px;color:var(--red-1);font-weight:700}
.menu-btn{display:none;width:42px;height:42px;border-radius:11px;background:var(--bg-2);border:1px solid var(--border-0);align-items:center;justify-content:center;color:var(--text-1);font-size:18px;flex-shrink:0}
.menu-btn:hover{background:var(--bg-3);color:var(--accent)}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:45}
.overlay.active{display:block}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border-1);border-radius:5px;border:2px solid var(--bg-0)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
.modal-card{background:var(--bg-1);border:1px solid var(--border-1);border-radius:18px;width:460px;max-width:100%;box-shadow:0 40px 100px rgba(0,0,0,0.8)}
.modal-header{padding:20px 24px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between}
.modal-close{width:32px;height:32px;border-radius:8px;background:transparent;border:none;color:var(--text-2);font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.modal-close:hover{background:var(--bg-2);color:var(--text-0)}
.modal-body{padding:22px 24px}
.modal-body input{margin-bottom:0}
.modal-footer{padding:16px 24px;border-top:1px solid var(--border-0);display:flex;gap:10px;justify-content:flex-end}
@media(max-width:900px){.sidebar{transform:translateX(-100%);width:280px}.sidebar.open{transform:translateX(0);box-shadow:40px 0 100px rgba(0,0,0,0.8)}.main{margin-left:0}.menu-btn{display:flex}.content{padding:24px}.topbar{padding:0 24px}.page-title{font-size:28px}}
@media(max-width:768px){.content{padding:18px}.topbar{padding:0 18px;height:60px}.page-header{margin-bottom:22px;flex-direction:column;align-items:stretch;gap:16px}.page-title{font-size:24px}.card{padding:22px}.stat{padding:18px 20px}.stat-value{font-size:26px}.script-card{padding:20px}.form-row{grid-template-columns:1fr;gap:0}.scripts-grid{grid-template-columns:1fr}.stats-row{grid-template-columns:1fr 1fr;gap:12px}.btn{padding:12px 18px}.login-card{padding:36px 28px}.login-logo{width:64px;height:64px;font-size:24px}.login-title{font-size:22px}}
@media(max-width:480px){.content{padding:14px}.topbar{padding:0 14px;height:58px}.page-title{font-size:22px}.card{padding:18px;border-radius:14px}.stat{padding:16px}.stat-value{font-size:22px}.script-card{padding:16px}.script-card-actions .btn{flex:1;min-width:100%}.script-card-actions{flex-direction:column}.stats-row{grid-template-columns:1fr;gap:10px}input,textarea,select{font-size:16px;padding:12px 14px}textarea{min-height:220px;font-size:12px}.login-card{padding:30px 22px}.login-logo{width:58px;height:58px;font-size:22px}.login-title{font-size:20px}.toast{left:14px;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));font-size:13px}}
`;

const TOAST_SCRIPT = `
function showToast(message, type='success'){const e=document.querySelector('.toast');if(e)e.remove();const t=document.createElement('div');t.className='toast '+type;t.textContent=message;document.body.appendChild(t);setTimeout(()=>{t.classList.add('hiding');setTimeout(()=>t.remove(),300)},2400)}
function copyText(text,btn){navigator.clipboard.writeText(text).then(()=>{if(btn){const o=btn.innerHTML;btn.innerHTML='✓ Copied';setTimeout(()=>btn.innerHTML=o,1400)}showToast('Copied','success')}).catch(()=>showToast('Failed','error'))}
function confirmDelete(token,name){if(confirm('Delete "'+name+'"?'))window.location.href='/delete/'+token}
function toggleSidebar(){document.querySelector('.sidebar').classList.toggle('open');document.querySelector('.overlay').classList.toggle('active');document.body.style.overflow=document.querySelector('.sidebar').classList.contains('open')?'hidden':''}
document.querySelectorAll('.nav-item').forEach(i=>{i.addEventListener('click',()=>{if(window.innerWidth<=900){document.querySelector('.sidebar').classList.remove('open');document.querySelector('.overlay').classList.remove('active');document.body.style.overflow=''}})});
`;

function renderLayout({ title, pageTitle, pageSubtitle, content, user, activeNav, actions }) {
    const isAdmin = user.role === 'ADMIN';
    return `<!DOCTYPE html><html lang="en"><head>${getHtmlHead(title)}<style>${LAYOUT_STYLES}</style></head><body>
    <div class="layout">
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-brand"><div class="sidebar-logo">ZK</div><div class="sidebar-brand-text"><div class="sidebar-brand-name">${BRAND_SHORT}</div><div class="sidebar-brand-sub">By Zyrox-Kido</div></div></div>
            <nav class="sidebar-nav">
                <div class="nav-section-label">Workspace</div>
                <a href="/" class="nav-item ${activeNav === 'dashboard' ? 'active' : ''}"><span class="nav-icon">◈</span> Dashboard</a>
                <a href="/create" class="nav-item ${activeNav === 'create' ? 'active' : ''}"><span class="nav-icon">✦</span> Create Script</a>
                <a href="/servers" class="nav-item ${activeNav === 'servers' ? 'active' : ''}"><span class="nav-icon">🏠</span> Servers</a>
                <a href="/friends" class="nav-item ${activeNav === 'friends' ? 'active' : ''}"><span class="nav-icon">👥</span> Friends</a>
                ${isAdmin ? `<div class="nav-section-label">Administration</div><a href="/admin" class="nav-item ${activeNav === 'admin' ? 'active' : ''}"><span class="nav-icon">♛</span> Admin Panel</a>` : ''}
            </nav>
            <div class="sidebar-footer">
                <a href="/logout" class="user-card"><div class="user-avatar ${isAdmin ? 'user-avatar-admin' : ''}">${user.username.charAt(0).toUpperCase()}</div><div class="user-meta"><div class="user-name">${user.username}</div><div class="user-role">${isAdmin ? '♛ Admin' : 'Member'}</div></div></a>
            </div>
        </aside>
        <div class="overlay" onclick="toggleSidebar()"></div>
        <div class="main">
            <header class="topbar">
                <div class="topbar-left"><button class="menu-btn" onclick="toggleSidebar()">☰</button><div class="topbar-title">${pageTitle}</div></div>
                <div class="topbar-right"><a href="/logout" class="icon-btn">⏻</a></div>
            </header>
            <div class="content">
                <div class="page-header"><div><div class="page-title">${pageTitle}</div>${pageSubtitle ? `<div class="page-subtitle">${pageSubtitle}</div>` : ''}</div>${actions || ''}</div>
                ${content}
            </div>
        </div>
    </div>
    <script>${TOAST_SCRIPT}</script>
    </body></html>`;
}

function renderScriptCard(s) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const slug = s.slug || 'Script';
    const version = s.version || 'V1';
    const prettyUrl = `${baseUrl}/raw/${slug}/${version}/${s.token}`;
    return `<div class="script-card">
        <div class="script-card-header"><div class="script-card-icon">◈</div><div class="script-card-info"><div class="script-card-name">${s.name}</div><div class="script-card-meta"><span class="badge badge-version">${version}</span><span>${new Date(s.created_at).toLocaleDateString()}</span></div></div></div>
        <div class="script-card-url">${prettyUrl}</div>
        <div class="script-card-actions">
            <button class="btn btn-primary btn-sm" onclick="copyText('loadstring(game:HttpGet(\\'${prettyUrl}\\'))()', this)">📋 Copy</button>
            <a href="/view/${slug}/${version}/${s.token}" target="_blank" class="btn btn-secondary btn-sm">◉ View</a>
            <a href="/edit/${s.token}" class="btn btn-ghost btn-sm">✎ Edit</a>
            <button class="btn btn-danger btn-sm" onclick="confirmDelete('${s.token}', '${s.name}')">🗑 Delete</button>
        </div>
    </div>`;
}

// ==================== AUTH ====================
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head>${getHtmlHead('Login')}<style>${LAYOUT_STYLES}</style></head><body>
    <div class="login-wrap"><div class="login-card">
        <div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">Welcome back</div><div class="login-sub">Sign in to continue to ${BRAND_SHORT}</div></div>
        <form action="/login" method="POST"><input type="text" name="username" placeholder="Username" required autofocus><input type="password" name="password" placeholder="Password" required><button type="submit" class="btn btn-primary">Sign In →</button></form>
        <div class="login-msg error">${req.query.error ? 'Invalid credentials' : ''}</div>
        <div class="login-msg success">${req.query.registered ? 'Account created! Please sign in.' : ''}</div>
        <a href="/register" class="login-link">Create an account →</a>
    </div></div></body></html>`);
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
    } catch (e) { res.redirect('/login?error=1'); }
});

app.get('/register', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head>${getHtmlHead('Register')}<style>${LAYOUT_STYLES}</style></head><body>
    <div class="login-wrap"><div class="login-card">
        <div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">Create account</div><div class="login-sub">Join ${BRAND_SHORT}</div></div>
        <form action="/register" method="POST"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><input type="password" name="confirmPassword" placeholder="Confirm password" required><button type="submit" class="btn btn-primary">Create Account →</button></form>
        <div class="login-msg error">${req.query.error || ''}</div>
        <a href="/login" class="login-link">← Back to sign in</a>
    </div></div></body></html>`);
});
app.post('/register', async (req, res) => {
    try {
        const { username, password, confirmPassword } = req.body;
        if (password !== confirmPassword) return res.redirect('/register?error=Passwords do not match');
        if (username.length < 2 || password.length < 4) return res.redirect('/register?error=Min 2 chars name, 4 chars password');
        const ex = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (ex.rows.length > 0) return res.redirect('/register?error=Username taken');
        const role = username === 'Z-K' ? 'ADMIN' : 'USER';
        const tag = Math.floor(1000 + Math.random() * 9000).toString();
        await pool.query('INSERT INTO users (username, password, role, display_name, tag) VALUES ($1, $2, $3, $4, $5)', [username, password, role, username, tag]);
        res.redirect('/login?registered=1');
    } catch (e) { res.redirect('/register?error=Server error'); }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==================== DASHBOARD ====================
app.get('/', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [req.session.user.username]);
        const myScripts = result.rows;
        const isAdmin = req.session.user.role === 'ADMIN';
        const statsHtml = `<div class="stats-row"><div class="stat"><div class="stat-icon">◈</div><div class="stat-label">Total Scripts</div><div class="stat-value">${myScripts.length}</div></div><div class="stat"><div class="stat-icon">${isAdmin ? '♛' : '★'}</div><div class="stat-label">Account Role</div><div class="stat-value stat-value-sm">${isAdmin ? 'Admin' : 'Member'}</div></div><div class="stat"><div class="stat-icon">◉</div><div class="stat-label">Username</div><div class="stat-value stat-value-sm">${req.session.user.username}</div></div></div>`;
        const scriptsHtml = myScripts.length === 0
            ? `<div class="empty"><div class="empty-icon">◈</div><div class="empty-title">No scripts yet</div><div class="empty-desc">Create your first script to get started</div><a href="/create" class="btn btn-primary">✦ Create Script</a></div>`
            : `<div class="scripts-grid">${myScripts.map(renderScriptCard).join('')}</div>`;
        res.send(renderLayout({ title: 'Dashboard', pageTitle: 'Dashboard', pageSubtitle: 'Manage your Lua scripts', content: statsHtml + scriptsHtml, user: req.session.user, activeNav: 'dashboard', actions: `<a href="/create" class="btn btn-primary">✦ New Script</a>` }));
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/create', requireLogin, (req, res) => {
    const content = `<div class="card" style="max-width:920px"><form action="/create" method="POST"><div class="form-row"><div class="form-group"><label class="form-label">Script Name</label><input type="text" name="name" placeholder="e.g., God Mode" required autofocus></div><div class="form-group"><label class="form-label">Version</label><select name="version" required>${versionDropdown('V1')}</select></div></div><div class="form-group"><label class="form-label">Lua Code</label><textarea name="content" placeholder="-- Paste your Lua script here..." required></textarea></div><div style="display:flex;gap:12px;flex-wrap:wrap;"><button type="submit" class="btn btn-primary">💾 Save Script</button><a href="/" class="btn btn-ghost">Cancel</a></div></form></div>`;
    res.send(renderLayout({ title: 'Create Script', pageTitle: 'Create Script', pageSubtitle: 'Add a new Lua script', content, user: req.session.user, activeNav: 'create' }));
});
app.post('/create', requireLogin, async (req, res) => {
    try {
        const { name, version, content } = req.body;
        const slug = makeSlug(name);
        const ver = version || 'V1';
        const token = crypto.randomBytes(16).toString('hex');
        await pool.query('INSERT INTO scripts (name, slug, version, real_content, public_content, token, owner) VALUES ($1, $2, $3, $4, $5, $6, $7)', [name, slug, ver, content, obfuscateScript(content), token, req.session.user.username]);
        res.redirect('/');
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/edit/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");
        const escaped = script.real_content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const content = `<div class="card" style="max-width:920px"><form action="/edit/${script.token}" method="POST"><div class="form-row"><div class="form-group"><label class="form-label">Script Name</label><input type="text" name="name" value="${script.name}" required></div><div class="form-group"><label class="form-label">Version</label><select name="version" required>${versionDropdown(script.version)}</select></div></div><div class="form-group"><label class="form-label">Lua Code</label><textarea name="content" required>${escaped}</textarea></div><div style="display:flex;gap:12px;flex-wrap:wrap;"><button type="submit" class="btn btn-primary">💾 Save Changes</button><a href="/" class="btn btn-ghost">Cancel</a></div></form></div>`;
        res.send(renderLayout({ title: 'Edit Script', pageTitle: `Edit: ${script.name}`, pageSubtitle: 'Update your script', content, user: req.session.user, activeNav: 'dashboard' }));
    } catch (e) { res.status(500).send('Error'); }
});
app.post('/edit/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Access Denied");
        const slug = makeSlug(req.body.name);
        const ver = req.body.version || 'V1';
        await pool.query('UPDATE scripts SET name = $1, slug = $2, version = $3, real_content = $4, public_content = $5 WHERE token = $6', [req.body.name, slug, ver, req.body.content, obfuscateScript(req.body.content), req.params.token]);
        res.redirect('/');
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/view/:slug/:version/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(404).send("Not found");
        const script = result.rows[0];
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const prettyUrl = `${baseUrl}/raw/${script.slug}/${script.version}/${script.token}`;
        const loadstring = `loadstring(game:HttpGet("${prettyUrl}"))()`;
        res.send(`<!DOCTYPE html><html lang="en"><head>${getHtmlHead(script.name)}<style>${LAYOUT_STYLES}</style></head><body>
        <div class="login-wrap"><div class="login-card" style="width:640px;text-align:center;">
            <div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">${script.name}</div><div class="login-sub" style="margin-top:10px;"><span class="badge badge-version">${script.version}</span></div></div>
            <div style="background:var(--bg-0);border:1px solid var(--border-0);border-radius:12px;padding:18px;margin-bottom:18px;text-align:left;"><div style="font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:12px;">Loadstring</div><div id="lsBox" style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--accent-bright);word-break:break-all;line-height:1.8;">${loadstring}</div></div>
            <button class="btn btn-primary btn-block" style="padding:15px;" onclick="copyText(document.getElementById('lsBox').innerText, this)">📋 Copy Loadstring</button>
            <div style="margin-top:24px;font-size:11px;color:var(--text-3);font-weight:600;">Protected by ${BRAND_NAME}</div>
        </div></div><script>${TOAST_SCRIPT}</script></body></html>`);
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/raw/:slug/:version/:token', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.status(403).send("-- Denied --");
        const script = result.rows[0];
        if (script.slug !== req.params.slug || script.version !== req.params.version) return res.status(403).send("-- Denied --");
        const ua = req.headers['user-agent'] || '';
        for (const b of ['Mozilla', 'Chrome', 'Safari', 'Firefox', 'Edge', 'curl', 'wget', 'Postman']) if (ua.includes(b)) return res.status(403).send("-- Protected --");
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(script.public_content);
    } catch (e) { res.status(500).send("-- Server Error --"); }
});

app.get('/delete/:token', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (result.rows.length === 0) return res.redirect('/');
        const script = result.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (script.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied");
        await pool.query('DELETE FROM scripts WHERE token = $1', [req.params.token]);
        if (isAdmin && script.owner !== req.session.user.username) return res.redirect('/admin/user/' + encodeURIComponent(script.owner));
        res.redirect('/');
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== SERVERS PAGE ====================
app.get('/servers', requireLogin, async (req, res) => {
    try {
        const me = req.session.user.username;
        const myServers = await pool.query(`
            SELECT s.*, 
                (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count
            FROM servers s
            WHERE s.owner = $1 OR s.id IN (SELECT server_id FROM server_members WHERE username = $1)
            ORDER BY s.created_at DESC
        `, [me]);
        
        let serverCards = '';
        if (myServers.rows.length === 0) {
            serverCards = `<div class="empty"><div class="empty-icon">🏠</div><div class="empty-title">No servers yet</div><div class="empty-desc">Create your first server to get started</div></div>`;
        } else {
            serverCards = '<div class="scripts-grid">';
            myServers.rows.forEach(s => {
                const isOwner = s.owner === me;
                serverCards += `
                    <div class="script-card" style="cursor:pointer" onclick="window.location.href='/server/${s.id}'">
                        <div class="script-card-header">
                            <div class="script-card-icon" style="font-size:22px;">${s.icon || '🎮'}</div>
                            <div class="script-card-info">
                                <div class="script-card-name">${s.name}</div>
                                <div class="script-card-meta">
                                    ${isOwner ? '<span class="badge badge-owner">👑 Owner</span>' : '<span class="badge badge-user">Member</span>'}
                                    <span>${s.member_count} members</span>
                                </div>
                            </div>
                        </div>
                        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-3);">Invite: <span style="color:var(--accent-bright);">${s.invite_code}</span></div>
                        <div class="script-card-actions" onclick="event.stopPropagation()">
                            <a href="/server/${s.id}" class="btn btn-primary btn-sm">Open Server</a>
                            <button onclick="copyText('${s.invite_code}', this)" class="btn btn-secondary btn-sm">📋 Copy Invite</button>
                        </div>
                    </div>
                `;
            });
            serverCards += '</div>';
        }
        
        const content = `
            <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
                <button onclick="openCreateServer()" class="btn btn-primary">➕ Create Server</button>
                <button onclick="openJoinServer()" class="btn btn-secondary">🔗 Join Server</button>
            </div>
            ${serverCards}
            
            <div id="createServerModal" class="modal-overlay" style="display:none;">
                <div class="modal-card">
                    <div class="modal-header"><h3 style="font-size:18px;font-weight:700;">Create Server</h3><button onclick="closeModal('createServerModal')" class="modal-close">×</button></div>
                    <div class="modal-body">
                        <label class="form-label">Server Name</label>
                        <input type="text" id="newServerName" placeholder="My Awesome Server" maxlength="100">
                        <label class="form-label" style="margin-top:14px;">Icon (emoji)</label>
                        <input type="text" id="newServerIcon" placeholder="🎮" maxlength="2" value="🎮">
                    </div>
                    <div class="modal-footer">
                        <button onclick="closeModal('createServerModal')" class="btn btn-ghost">Cancel</button>
                        <button onclick="createServer()" class="btn btn-primary">Create</button>
                    </div>
                </div>
            </div>
            
            <div id="joinServerModal" class="modal-overlay" style="display:none;">
                <div class="modal-card">
                    <div class="modal-header"><h3 style="font-size:18px;font-weight:700;">Join Server</h3><button onclick="closeModal('joinServerModal')" class="modal-close">×</button></div>
                    <div class="modal-body">
                        <label class="form-label">Invite Code</label>
                        <input type="text" id="joinInviteCode" placeholder="Enter invite code..." maxlength="16">
                    </div>
                    <div class="modal-footer">
                        <button onclick="closeModal('joinServerModal')" class="btn btn-ghost">Cancel</button>
                        <button onclick="joinServer()" class="btn btn-primary">Join</button>
                    </div>
                </div>
            </div>
            
            <script>
                function openCreateServer() { document.getElementById('createServerModal').style.display = 'flex'; }
                function openJoinServer() { document.getElementById('joinServerModal').style.display = 'flex'; }
                function closeModal(id) { document.getElementById(id).style.display = 'none'; }
                
                async function createServer() {
                    const name = document.getElementById('newServerName').value.trim();
                    const icon = document.getElementById('newServerIcon').value.trim() || '🎮';
                    if (!name) return showToast('Name required', 'error');
                    const r = await fetch('/api/servers/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, icon })
                    });
                    const data = await r.json();
                    if (data.id) { showToast('Server created!', 'success'); window.location.href = '/server/' + data.id; }
                    else showToast(data.error || 'Failed', 'error');
                }
                
                async function joinServer() {
                    const code = document.getElementById('joinInviteCode').value.trim();
                    if (!code) return showToast('Code required', 'error');
                    const r = await fetch('/api/servers/join', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ invite_code: code })
                    });
                    const data = await r.json();
                    if (data.id) { showToast('Joined!', 'success'); window.location.href = '/server/' + data.id; }
                    else showToast(data.error || 'Invalid code', 'error');
                }
            </script>
        `;
        
        res.send(renderLayout({ title: 'Servers', pageTitle: 'Servers', pageSubtitle: 'Your Discord-style servers', content, user: req.session.user, activeNav: 'servers' }));
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

// ==================== SERVER APIs ====================
app.post('/api/servers/create', requireLogin, async (req, res) => {
    try {
        const { name, icon } = req.body;
        if (!name || name.length < 2) return res.status(400).json({ error: 'Name too short' });
        const invite = crypto.randomBytes(6).toString('hex');
        const r = await pool.query(
            'INSERT INTO servers (name, owner, invite_code, icon) VALUES ($1, $2, $3, $4) RETURNING *',
            [name.substring(0, 100), req.session.user.username, invite, (icon || '🎮').substring(0, 2)]
        );
        const server = r.rows[0];
        await pool.query('INSERT INTO server_members (server_id, username, role) VALUES ($1, $2, $3)', [server.id, req.session.user.username, 'OWNER']);
        await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4)', [server.id, 'general', 'text', req.session.user.username]);
        await pool.query('INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4)', [server.id, 'voice', 'voice', req.session.user.username]);
        res.json(server);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/servers/join', requireLogin, async (req, res) => {
    try {
        const { invite_code } = req.body;
        const r = await pool.query('SELECT * FROM servers WHERE invite_code = $1', [invite_code]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Invalid invite code' });
        const server = r.rows[0];
        const existing = await pool.query('SELECT * FROM server_members WHERE server_id = $1 AND username = $2', [server.id, req.session.user.username]);
        if (existing.rows.length === 0) {
            await pool.query('INSERT INTO server_members (server_id, username) VALUES ($1, $2)', [server.id, req.session.user.username]);
        }
        res.json(server);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== SERVER VIEW ====================
app.get('/server/:id', requireLogin, async (req, res) => {
    try {
        const serverId = parseInt(req.params.id);
        const me = req.session.user.username;
        const serverR = await pool.query('SELECT * FROM servers WHERE id = $1', [serverId]);
        if (serverR.rows.length === 0) return res.status(404).send('Server not found');
        const srv = serverR.rows[0];
        const isOwner = srv.owner === me;
        const isAdmin = req.session.user.role === 'ADMIN';
        
        const memberCheck = await pool.query('SELECT * FROM server_members WHERE server_id = $1 AND username = $2', [serverId, me]);
        if (memberCheck.rows.length === 0 && !isOwner && !isAdmin) {
            return res.redirect('/servers');
        }
        
        const channelsR = await pool.query('SELECT * FROM channels WHERE server_id = $1 ORDER BY type DESC, name ASC', [serverId]);
        const channels = channelsR.rows;
        const textChannels = channels.filter(c => c.type !== 'voice');
        const voiceChannels = channels.filter(c => c.type === 'voice');
        const membersR = await pool.query('SELECT * FROM server_members WHERE server_id = $1', [serverId]);
        
        const content = `
        <div class="chat-layout" style="grid-template-columns:240px 1fr 200px;">
            <div class="chat-sidebar" id="chatSidebar">
                <div class="chat-sidebar-header">
                    <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
                        <span style="font-size:20px;">${srv.icon || '🎮'}</span>
                        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${srv.name}</span>
                    </div>
                </div>
                <div class="chat-channels-list">
                    <div class="channel-group-label" style="display:flex;justify-content:space-between;align-items:center;">
                        <span>💬 TEXT</span>
                        <button onclick="openCreateChannel('text')" style="background:none;border:none;color:var(--text-3);font-size:16px;cursor:pointer;">+</button>
                    </div>
                    <div id="channelsList">
                        ${textChannels.map(c => `<div class="channel-item" data-id="${c.id}" data-name="${c.name}" onclick="switchChannel(${c.id}, '${c.name.replace(/'/g, "\\'")}')"><span class="channel-hash">#</span><span class="channel-name">${c.name}</span></div>`).join('')}
                    </div>
                    <div class="channel-group-label" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;">
                        <span>🔊 VOICE</span>
                        <button onclick="openCreateChannel('voice')" style="background:none;border:none;color:var(--text-3);font-size:16px;cursor:pointer;">+</button>
                    </div>
                    <div id="voiceChannelsList">
                        ${voiceChannels.map(vc => `<div class="voice-channel-item" data-id="${vc.id}" data-name="${vc.name}"><div class="voice-item-header"><span class="voice-icon">🔊</span><span class="voice-name">${vc.name}</span><span class="voice-count" id="voice-count-${vc.id}" style="display:none;">0</span></div><div class="voice-participants" id="voice-participants-${vc.id}"></div><button class="voice-join-btn" onclick="joinVoice(${vc.id}, '${vc.name.replace(/'/g, "\\'")}')">Join</button></div>`).join('')}
                    </div>
                </div>
                <div class="chat-sidebar-footer">
                    <a href="/servers" style="display:block;text-align:center;color:var(--text-2);font-size:12px;font-weight:700;padding:8px;">← All Servers</a>
                </div>
            </div>
            <div class="chat-main">
                <div class="chat-header">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <button class="chat-mobile-toggle" onclick="toggleChatSidebar()">☰</button>
                        <span style="color:var(--text-2);font-size:18px;">#</span>
                        <span id="currentChannelName" style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;">${textChannels[0]?.name || 'general'}</span>
                    </div>
                    <div style="font-size:11px;color:var(--text-3);font-weight:600;">Invite: ${srv.invite_code}</div>
                </div>
                <div id="chatMessages" class="chat-messages"><div style="text-align:center;color:var(--text-3);padding:20px 0;">Loading...</div></div>
                <div class="chat-input-area">
                    <form id="chatForm">
                        <input type="text" id="chatInput" placeholder="Message..." maxlength="500" autocomplete="off">
                        <button type="submit" class="btn btn-primary">➤</button>
                    </form>
                </div>
            </div>
            <div class="chat-sidebar" style="border-left:1px solid var(--border-0);border-right:none;">
                <div class="chat-sidebar-header" style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:13px;">👥 Members (${membersR.rows.length})</div>
                <div style="overflow-y:auto;flex:1;padding:10px 8px;">
                    ${membersR.rows.map(m => `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:13px;color:var(--text-1);font-weight:600;"><div style="width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;">${m.username.charAt(0).toUpperCase()}</div>${m.username} ${m.role === 'OWNER' ? '👑' : ''}</div>`).join('')}
                </div>
            </div>
        </div>
        
        <div id="voicePanel" class="voice-panel" style="display:none;">
            <div class="voice-panel-header"><div style="display:flex;align-items:center;gap:8px;"><div class="voice-live-dot"></div><span id="voicePanelName" style="font-weight:700;font-size:13px;">Voice</span></div><button onclick="minimizeVoice()" class="voice-min-btn">−</button></div>
            <div id="voiceVideos" class="voice-videos"></div>
            <div class="voice-controls"><button id="muteBtn" onclick="toggleMute()" class="voice-ctrl-btn">🎤</button><button id="shareBtn" onclick="toggleShareScreen()" class="voice-ctrl-btn">🖥️</button><button onclick="leaveVoice()" class="voice-ctrl-btn voice-ctrl-leave">📞</button></div>
        </div>
        
        <div id="createChannelModal" class="modal-overlay" style="display:none;">
            <div class="modal-card">
                <div class="modal-header"><h3 style="font-size:18px;font-weight:700;" id="createChannelTitle">Create Channel</h3><button onclick="closeModal('createChannelModal')" class="modal-close">×</button></div>
                <div class="modal-body">
                    <label class="form-label">Channel Name</label>
                    <input type="text" id="newChannelName" placeholder="e.g., gaming" maxlength="50">
                </div>
                <div class="modal-footer">
                    <button onclick="closeModal('createChannelModal')" class="btn btn-ghost">Cancel</button>
                    <button onclick="createChannel()" class="btn btn-primary">Create</button>
                </div>
            </div>
        </div>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
        const SERVER_ID = ${serverId};
        const socket = io();
        const currentUser = ${JSON.stringify(req.session.user.username)};
        const currentRole = ${JSON.stringify(req.session.user.role)};
        const isAdmin = currentRole === 'ADMIN';
        const isServerOwner = ${isOwner};
        let currentChannelId = null;
        let currentChannelType = 'text';
        let localStream = null, screenStream = null;
        let peerConnections = {};
        let currentVoiceChannelId = null;
        let isMuted = false, isSharing = false;
        const iceServers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
        const messagesEl = document.getElementById('chatMessages');
        const form = document.getElementById('chatForm');
        const input = document.getElementById('chatInput');
        
        socket.emit('register_user', { username: currentUser });
        
        function escapeHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML}
        function formatTime(ts){const d=new Date(ts);return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
        function toggleChatSidebar(){document.getElementById('chatSidebar').classList.toggle('mobile-open')}
        function closeModal(id){document.getElementById(id).style.display='none'}
        function openCreateChannel(type){
            currentChannelType = type;
            document.getElementById('createChannelTitle').textContent = type === 'voice' ? 'Create Voice Channel' : 'Create Text Channel';
            document.getElementById('createChannelModal').style.display = 'flex';
            document.getElementById('newChannelName').value = '';
            document.getElementById('newChannelName').focus();
        }
        
        async function createChannel(){
            const name = document.getElementById('newChannelName').value.trim();
            if (!name) return showToast('Name required', 'error');
            try {
                const r = await fetch('/api/servers/' + SERVER_ID + '/channels', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, type: currentChannelType })
                });
                const data = await r.json();
                if (data.id) {
                    if (data.type === 'voice') addVoiceChannelToList(data);
                    else addTextChannelToList(data);
                    closeModal('createChannelModal');
                    showToast('Channel created!', 'success');
                } else showToast(data.error || 'Failed', 'error');
            } catch(e) { showToast('Network error', 'error'); }
        }
        
        function addTextChannelToList(c){
            const list = document.getElementById('channelsList');
            const div = document.createElement('div');
            div.className = 'channel-item';
            div.dataset.id = c.id;
            div.innerHTML = '<span class="channel-hash">#</span><span class="channel-name">' + escapeHtml(c.name) + '</span>';
            div.onclick = () => switchChannel(c.id, c.name);
            list.appendChild(div);
        }
        function addVoiceChannelToList(c){
            const list = document.getElementById('voiceChannelsList');
            const div = document.createElement('div');
            div.className = 'voice-channel-item';
            div.dataset.id = c.id;
            div.innerHTML = '<div class="voice-item-header"><span class="voice-icon">🔊</span><span class="voice-name">' + escapeHtml(c.name) + '</span><span class="voice-count" id="voice-count-' + c.id + '" style="display:none;">0</span></div><div class="voice-participants" id="voice-participants-' + c.id + '"></div><button class="voice-join-btn" onclick="joinVoice(' + c.id + ', \\'' + c.name.replace(/'/g, "\\\\'") + '\\')">Join</button>';
            list.appendChild(div);
        }
        
        function switchChannel(id, name){
            currentChannelId = id;
            document.getElementById('currentChannelName').textContent = name;
            input.placeholder = 'Message #' + name;
            document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
            const a = document.querySelector('.channel-item[data-id="' + id + '"]');
            if (a) a.classList.add('active');
            messagesEl.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:20px 0;">Loading...</div>';
            socket.emit('switch_channel', { channelId: id });
            if (window.innerWidth <= 768) document.getElementById('chatSidebar').classList.remove('mobile-open');
        }
        
        function renderMessage(msg, isNew){
            const isOwn = msg.username === currentUser;
            const isA = msg.role === 'ADMIN';
            const div = document.createElement('div');
            div.className = 'chat-message';
            div.dataset.id = msg.id;
            if (isNew) div.style.animation = 'msgIn 0.3s ease';
            const av = isA ? 'linear-gradient(135deg,#ffaa00,#ff6600)' : 'linear-gradient(135deg,var(--red-1),var(--red-2))';
            const rb = isA ? '<span style="font-size:9px;font-weight:800;color:#ffaa00;background:rgba(255,170,0,0.12);padding:2px 6px;border-radius:5px;margin-left:6px;">ADMIN</span>' : '';
            div.innerHTML = '<div class="msg-avatar" style="background:' + av + ';">' + escapeHtml(msg.username.charAt(0).toUpperCase()) + '</div><div class="msg-body"><div class="msg-meta"><span class="msg-username" style="color:' + (isOwn ? 'var(--accent-bright)' : 'var(--text-0)') + ';">' + (isOwn ? 'You' : escapeHtml(msg.username)) + '</span>' + rb + '<span class="msg-time">' + formatTime(msg.created_at) + '</span></div><div class="msg-content">' + escapeHtml(msg.message) + '</div>' + (isAdmin && !isOwn ? '<button class="msg-delete" onclick="deleteMsg(' + msg.id + ')">🗑 Delete</button>' : '') + '</div>';
            return div;
        }
        
        socket.on('chat_history', msgs => {
            messagesEl.innerHTML = '';
            if (msgs.length === 0) { messagesEl.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:60px 20px;"><div style="font-size:48px;margin-bottom:12px;">👋</div><div style="font-size:15px;font-weight:700;color:var(--text-2);">Welcome!</div></div>'; return; }
            msgs.forEach(m => messagesEl.appendChild(renderMessage(m)));
            messagesEl.scrollTop = messagesEl.scrollHeight;
        });
        socket.on('new_message', msg => { messagesEl.appendChild(renderMessage(msg, true)); messagesEl.scrollTop = messagesEl.scrollHeight; });
        socket.on('message_deleted', ({messageId}) => { const el = messagesEl.querySelector('[data-id="' + messageId + '"]'); if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); } });
        
        form.addEventListener('submit', e => {
            e.preventDefault();
            const msg = input.value.trim();
            if (!msg || !currentChannelId) return;
            socket.emit('send_message', { username: currentUser, role: currentRole, message: msg, channelId: currentChannelId });
            input.value = '';
        });
        
        window.deleteMsg = id => { if (confirm('Delete?')) socket.emit('delete_message', { messageId: id, role: currentRole, channelId: currentChannelId }); };
        
        // VOICE
        window.joinVoice = async (channelId, channelName) => {
            try {
                if (currentVoiceChannelId === channelId) return;
                if (currentVoiceChannelId) window.leaveVoice();
                try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); } catch (e) { return showToast('Mic denied', 'error'); }
                currentVoiceChannelId = channelId;
                document.getElementById('voicePanelName').textContent = channelName;
                document.getElementById('voicePanel').style.display = 'flex';
                document.getElementById('voiceVideos').innerHTML = '';
                addVideoTile('self', 'You', localStream, false, true);
                socket.emit('join_voice', { voiceChannelId: channelId, username: currentUser, role: currentRole });
                showToast('Joined ' + channelName, 'success');
            } catch (e) { showToast('Failed', 'error'); }
        };
        window.leaveVoice = () => {
            if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
            if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
            Object.values(peerConnections).forEach(({ pc }) => { try { pc.close(); } catch(e){} });
            peerConnections = {};
            socket.emit('leave_voice');
            currentVoiceChannelId = null; isSharing = false; isMuted = false;
            document.getElementById('voicePanel').style.display = 'none';
            document.getElementById('voiceVideos').innerHTML = '';
            document.getElementById('muteBtn').textContent = '🎤';
            document.getElementById('shareBtn').textContent = '🖥️';
            document.getElementById('shareBtn').style.background = '';
        };
        window.toggleMute = () => { if (!localStream) return; isMuted = !isMuted; localStream.getAudioTracks().forEach(t => t.enabled = !isMuted); document.getElementById('muteBtn').textContent = isMuted ? '🔇' : '🎤'; socket.emit('toggle_mute', { isMuted }); };
        window.toggleShareScreen = async () => {
            if (!currentVoiceChannelId) return;
            if (isSharing) {
                if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
                isSharing = false;
                document.getElementById('shareBtn').textContent = '🖥️';
                document.getElementById('shareBtn').style.background = '';
                document.querySelector('[data-tile="self-screen"]')?.remove();
                for (const [sid, { pc }] of Object.entries(peerConnections)) {
                    try { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('webrtc_offer', { targetSocketId: sid, offer, isScreenShare: false }); } catch(e){}
                }
            } else {
                try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false }); } catch (e) { return; }
                isSharing = true;
                document.getElementById('shareBtn').textContent = '⏹️';
                document.getElementById('shareBtn').style.background = 'linear-gradient(135deg, var(--red-1), var(--red-2))';
                addVideoTile('self-screen', 'Your Screen', screenStream, true, true);
                screenStream.getVideoTracks()[0].onended = () => { if (isSharing) window.toggleShareScreen(); };
                for (const [sid, { pc }] of Object.entries(peerConnections)) {
                    try {
                        const vt = screenStream.getVideoTracks()[0];
                        const s = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                        if (s) await s.replaceTrack(vt); else pc.addTrack(vt, screenStream);
                        const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('webrtc_offer', { targetSocketId: sid, offer, isScreenShare: true });
                    } catch(e){}
                }
            }
        };
        window.minimizeVoice = () => { const v = document.getElementById('voiceVideos'); v.style.display = v.style.display === 'none' ? 'grid' : 'none'; };
        
        function createPeerConnection(sid) {
            if (peerConnections[sid]) return peerConnections[sid].pc;
            const pc = new RTCPeerConnection(iceServers);
            if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
            if (screenStream) screenStream.getVideoTracks().forEach(t => pc.addTrack(t, screenStream));
            pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc_ice_candidate', { targetSocketId: sid, candidate: e.candidate }); };
            pc.ontrack = e => {
                const rs = e.streams[0]; const isV = e.track.kind === 'video'; const meta = peerConnections[sid];
                if (isV) { const tid = sid + '-screen'; if (!document.querySelector('[data-tile="' + tid + '"]')) addVideoTile(tid, (meta?.username || 'User') + "'s Screen", rs, true, false, sid); }
                else { const tid = sid + '-audio'; if (!document.querySelector('[data-tile="' + tid + '"]')) addVideoTile(tid, (meta?.username || 'User'), rs, false, false, sid); }
            };
            pc.onconnectionstatechange = () => { if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) removePeer(sid); };
            peerConnections[sid] = { pc, username: null, isOfferer: false };
            return pc;
        }
        function removePeer(sid) { if (peerConnections[sid]) { try { peerConnections[sid].pc.close(); } catch(e){} delete peerConnections[sid]; } document.querySelector('[data-tile="' + sid + '-screen"]')?.remove(); document.querySelector('[data-tile="' + sid + '-audio"]')?.remove(); }
        function addVideoTile(id, label, stream, isScreen, isSelf) {
            const videos = document.getElementById('voiceVideos');
            const tile = document.createElement('div');
            tile.className = 'voice-tile' + (isScreen ? ' voice-tile-screen' : '');
            tile.dataset.tile = id;
            const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = isSelf; v.srcObject = stream;
            const l = document.createElement('div'); l.className = 'voice-tile-label'; l.textContent = label;
            tile.appendChild(v); tile.appendChild(l); videos.appendChild(tile);
        }
        
        socket.on('voice_participants', ps => {
            document.querySelectorAll('.voice-participants').forEach(el => el.innerHTML = '');
            document.querySelectorAll('.voice-count').forEach(el => { el.textContent = '0'; el.style.display = 'none'; });
            ps.forEach(p => {
                const c = document.getElementById('voice-participants-' + currentVoiceChannelId);
                if (c) { const d = document.createElement('div'); d.className = 'voice-user'; d.innerHTML = '<div class="voice-user-avatar">' + escapeHtml(p.username.charAt(0).toUpperCase()) + '</div>' + escapeHtml(p.username) + (p.isMuted ? ' 🔇' : '') + (p.isStreaming ? ' 🖥️' : ''); c.appendChild(d); }
            });
            const cnt = document.getElementById('voice-count-' + currentVoiceChannelId);
            if (cnt) { cnt.textContent = ps.length; cnt.style.display = ps.length > 0 ? 'inline-block' : 'none'; }
        });
        socket.on('voice_existing_users', async ({ users }) => {
            for (const u of users) {
                try {
                    const pc = createPeerConnection(u.socketId);
                    peerConnections[u.socketId].username = u.username;
                    peerConnections[u.socketId].isOfferer = true;
                    const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit('webrtc_offer', { targetSocketId: u.socketId, offer, isScreenShare: false });
                } catch(e){}
            }
        });
        socket.on('webrtc_offer', async ({ fromSocketId, fromUsername, offer }) => {
            try {
                const pc = createPeerConnection(fromSocketId);
                peerConnections[fromSocketId].username = fromUsername;
                await pc.setRemoteDescription(new RTCSessionDescription(offer));
                const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
                socket.emit('webrtc_answer', { targetSocketId: fromSocketId, answer });
            } catch(e){}
        });
        socket.on('webrtc_answer', async ({ fromSocketId, answer }) => { try { const p = peerConnections[fromSocketId]; if (p && p.pc.signalingState !== 'stable') await p.pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch(e){} });
        socket.on('webrtc_ice_candidate', async ({ fromSocketId, candidate }) => { try { const p = peerConnections[fromSocketId]; if (p && candidate) await p.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){} });
        socket.on('user_left_voice', ({ socketId }) => removePeer(socketId));
        
        const firstText = document.querySelector('.channel-item');
        if (firstText) {
            const fid = parseInt(firstText.dataset.id);
            switchChannel(fid, firstText.dataset.name);
        }
        </script>
        
        <style>
        @keyframes msgIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        .chat-layout{display:grid;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:16px;overflow:hidden;height:calc(100vh - 220px);min-height:500px;position:relative}
        .chat-sidebar{background:var(--bg-0);border-right:1px solid var(--border-0);display:flex;flex-direction:column}
        .chat-sidebar-header{padding:16px 18px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between}
        .chat-channels-list{flex:1;overflow-y:auto;padding:10px 8px}
        .channel-group-label{font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:1px;padding:8px 12px 6px 12px}
        .channel-item{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;cursor:pointer;color:var(--text-2);font-size:13.5px;font-weight:600;margin-bottom:2px;position:relative}
        .channel-item:hover{background:var(--bg-2);color:var(--text-0)}
        .channel-item.active{background:var(--accent-dim);color:var(--accent)}
        .channel-item.active::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:60%;background:var(--accent);border-radius:0 3px 3px 0}
        .channel-hash{color:var(--text-3);font-size:16px;font-weight:700}
        .channel-item.active .channel-hash{color:var(--accent)}
        .channel-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .voice-channel-item{display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:9px 12px;background:var(--bg-2);border-radius:10px;margin-bottom:6px}
        .voice-item-header{display:flex;align-items:center;gap:8px;padding:4px 0}
        .voice-icon{font-size:14px}
        .voice-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;color:var(--text-1)}
        .voice-count{background:var(--accent);color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px}
        .voice-join-btn{background:var(--accent-dim);border:1px solid rgba(255,59,59,0.3);color:var(--accent);padding:6px 12px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit}
        .voice-join-btn:hover{background:var(--accent);color:#fff}
        .voice-participants{display:flex;flex-direction:column;gap:3px;margin-left:4px}
        .voice-user{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2);font-weight:600;padding:3px 0}
        .voice-user-avatar{width:18px;height:18px;border-radius:6px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:800}
        .chat-sidebar-footer{padding:12px;border-top:1px solid var(--border-0)}
        .chat-main{display:flex;flex-direction:column;min-width:0}
        .chat-header{padding:16px 24px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between;background:var(--bg-0)}
        .chat-mobile-toggle{display:none;background:var(--bg-2);border:1px solid var(--border-0);color:var(--text-1);font-size:16px;width:32px;height:32px;border-radius:8px;cursor:pointer;align-items:center;justify-content:center;margin-right:4px}
        .chat-messages{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:14px}
        .chat-message{display:flex;gap:12px;align-items:flex-start}
        .msg-avatar{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;flex-shrink:0;box-shadow:0 2px 12px rgba(255,59,59,0.25)}
        .msg-body{flex:1;min-width:0}
        .msg-meta{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
        .msg-username{font-weight:700;font-size:13.5px}
        .msg-time{font-size:11px;color:var(--text-3);font-weight:600}
        .msg-content{font-size:14px;line-height:1.55;color:var(--text-0);word-wrap:break-word}
        .msg-delete{background:none;border:none;color:var(--text-3);font-size:10.5px;cursor:pointer;margin-top:6px;padding:0;font-weight:600}
        .msg-delete:hover{color:var(--accent)}
        .chat-input-area{padding:16px 20px;border-top:1px solid var(--border-0);background:var(--bg-0)}
        .chat-input-area form{display:flex;gap:10px;align-items:center}
        .chat-input-area input{flex:1;margin:0;background:var(--bg-2);border-color:transparent}
        .chat-input-area input:focus{background:var(--bg-1);border-color:var(--accent)}
        .chat-input-area .btn{padding:13px 20px;flex-shrink:0}
        .voice-panel{position:fixed;bottom:24px;right:24px;width:380px;max-width:calc(100vw - 32px);background:rgba(15,8,8,0.95);backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);border:1px solid var(--border-1);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,0.7);z-index:9998;display:flex;flex-direction:column;overflow:hidden}
        .voice-panel-header{padding:12px 16px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between}
        .voice-live-dot{width:8px;height:8px;border-radius:50%;background:var(--red-1);box-shadow:0 0 12px var(--accent-glow);animation:pulse 1.5s infinite}
        .voice-min-btn{width:24px;height:24px;border-radius:6px;background:transparent;border:1px solid var(--border-0);color:var(--text-2);font-size:16px;cursor:pointer}
        .voice-videos{padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:320px;overflow-y:auto}
        .voice-tile{position:relative;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:1;border:1px solid var(--border-0)}
        .voice-tile-screen{grid-column:span 2;aspect-ratio:16/10}
        .voice-tile video{width:100%;height:100%;object-fit:cover;display:block}
        .voice-tile-label{position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.75);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;max-width:calc(100% - 8px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .voice-controls{padding:12px 16px;border-top:1px solid var(--border-0);display:flex;gap:10px;justify-content:center}
        .voice-ctrl-btn{width:46px;height:46px;border-radius:12px;background:var(--bg-2);border:1px solid var(--border-0);color:var(--text-0);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
        .voice-ctrl-btn:hover{background:var(--bg-3);border-color:var(--border-1)}
        .voice-ctrl-leave{background:rgba(255,59,59,0.15);border-color:rgba(255,59,59,0.3);color:var(--accent)}
        @media(max-width:900px){
            .chat-layout{grid-template-columns:1fr!important;height:calc(100vh - 200px)}
            .chat-layout > .chat-sidebar:nth-child(3){display:none}
            .chat-sidebar:first-child{position:absolute;top:0;left:0;bottom:0;width:260px;z-index:10;transform:translateX(-100%);transition:transform 0.3s}
            .chat-sidebar.mobile-open{transform:translateX(0);box-shadow:20px 0 60px rgba(0,0,0,0.8)}
            .chat-mobile-toggle{display:flex}
            .voice-panel{bottom:12px;right:12px;left:12px;width:auto}
        }
        </style>`;
        
        res.send(renderLayout({ title: srv.name, pageTitle: srv.name, pageSubtitle: `${membersR.rows.length} members`, content, user: req.session.user, activeNav: 'servers' }));
    } catch (e) { console.error(e); res.status(500).send('Error: ' + e.message); }
});

// ==================== SERVER CHANNEL API ====================
app.post('/api/servers/:id/channels', requireLogin, async (req, res) => {
    try {
        const serverId = parseInt(req.params.id);
        const { name, type } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        const cleanName = name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-').substring(0, 30);
        if (!cleanName) return res.status(400).json({ error: 'Invalid name' });
        const check = await pool.query('SELECT * FROM channels WHERE server_id = $1 AND name = $2', [serverId, cleanName]);
        if (check.rows.length > 0) return res.status(400).json({ error: 'Channel exists' });
        const r = await pool.query(
            'INSERT INTO channels (server_id, name, type, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
            [serverId, cleanName, type === 'voice' ? 'voice' : 'text', req.session.user.username]
        );
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== FRIENDS PAGE ====================
app.get('/friends', requireLogin, (req, res) => {
    const me = req.session.user.username;
    const content = `
    <div class="friends-layout">
        <div class="friends-sidebar" id="friendsSidebar">
            <button class="friend-tab active" data-tab="all" onclick="switchFriendTab('all')"><span>👥</span> All Friends</button>
            <button class="friend-tab" data-tab="pending" onclick="switchFriendTab('pending')"><span>📬</span> Pending <span id="pendingBadge" class="friend-badge" style="display:none;">0</span></button>
            <button class="friend-tab" data-tab="add" onclick="switchFriendTab('add')"><span>➕</span> Add Friend</button>
            <div style="padding:14px;">
                <div style="font-size:10px;font-weight:800;color:var(--text-3);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Your Profile</div>
                <div class="friend-profile-mini">
                    <div class="friend-avatar">${me.charAt(0).toUpperCase()}</div>
                    <div style="min-width:0;flex:1;">
                        <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="myDisplayName">${me}</div>
                        <div style="font-size:11px;color:var(--text-3);font-weight:600;" id="myTag">#----</div>
                    </div>
                </div>
                <button onclick="openProfileModal()" class="btn btn-ghost btn-sm" style="width:100%;margin-top:8px;">Edit Profile</button>
            </div>
        </div>
        <div class="friends-main">
            <div class="friends-header">
                <div style="display:flex;align-items:center;gap:10px;">
                    <button class="chat-mobile-toggle" onclick="toggleFriendsSidebar()">☰</button>
                    <span id="friendsTitle" style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;">All Friends</span>
                </div>
            </div>
            <div id="friendsContent" class="friends-content"><div style="text-align:center;color:var(--text-3);padding:40px;">Loading...</div></div>
        </div>
    </div>

    <div id="profileModal" class="modal-overlay" style="display:none;"><div class="modal-card"><div class="modal-header"><h3 style="font-size:18px;font-weight:700;">Edit Profile</h3><button onclick="closeProfileModal()" class="modal-close">×</button></div><div class="modal-body"><label class="form-label">Display Name</label><input type="text" id="editDisplayName" maxlength="50" placeholder="Your name"><label class="form-label" style="margin-top:14px;">Bio</label><input type="text" id="editBio" maxlength="200" placeholder="Tell us about yourself"><div style="margin-top:16px;padding:12px;background:var(--bg-2);border-radius:10px;"><div style="font-size:10px;font-weight:800;color:var(--text-3);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Your ID</div><div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;color:var(--accent-bright);" id="myFullId">...</div></div></div><div class="modal-footer"><button onclick="closeProfileModal()" class="btn btn-ghost">Cancel</button><button onclick="saveProfile()" class="btn btn-primary">Save</button></div></div></div>

    <div id="dmModal" class="modal-overlay" style="display:none;"><div class="modal-card" style="width:520px;"><div class="modal-header"><h3 style="font-size:16px;font-weight:700;" id="dmTitle">DM</h3><button onclick="closeDM()" class="modal-close">×</button></div><div id="dmMessages" style="padding:16px 22px;max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;"></div><div style="padding:14px 22px;border-top:1px solid var(--border-0);"><form id="dmForm" style="display:flex;gap:10px;"><input type="text" id="dmInput" placeholder="Type a message..." maxlength="1000" style="flex:1;"><button type="submit" class="btn btn-primary">➤</button></form></div></div></div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
    const socket = io();
    const me = ${JSON.stringify(req.session.user.username)};
    let currentTab = 'all';
    let currentDM = null;
    let friendsData = { friends: [], incoming: [], outgoing: [] };
    socket.emit('register_user', { username: me });
    function escapeHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML}

    async function loadFriends() {
        try { const r = await fetch('/api/friends'); friendsData = await r.json(); updatePendingBadge(); renderTab(currentTab); } catch (e) { console.error(e); }
    }
    function updatePendingBadge() {
        const badge = document.getElementById('pendingBadge');
        const count = friendsData.incoming.length;
        if (count > 0) { badge.textContent = count; badge.style.display = 'inline-block'; } else badge.style.display = 'none';
    }
    function switchFriendTab(tab) {
        currentTab = tab;
        document.querySelectorAll('.friend-tab').forEach(el => el.classList.remove('active'));
        document.querySelector('.friend-tab[data-tab="' + tab + '"]').classList.add('active');
        const titles = { all: 'All Friends', pending: 'Pending', add: 'Add Friend' };
        document.getElementById('friendsTitle').textContent = titles[tab];
        renderTab(tab);
    }
    function renderTab(tab) {
        const content = document.getElementById('friendsContent');
        if (tab === 'all') {
            if (friendsData.friends.length === 0) { content.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><div class="empty-title">No friends yet</div></div>'; return; }
            content.innerHTML = friendsData.friends.map(f => \`<div class="friend-row"><div class="friend-avatar">\${escapeHtml((f.display_name || f.username).charAt(0).toUpperCase())}</div><div style="flex:1;min-width:0;"><div class="friend-name">\${escapeHtml(f.display_name || f.username)}</div><div class="friend-tag">@\${escapeHtml(f.username)}#\${f.tag || '????'}</div></div><button onclick="openDM('\${escapeHtml(f.username)}')" class="btn btn-primary btn-sm">💬 DM</button><button onclick="removeFriend('\${escapeHtml(f.username)}')" class="btn btn-danger btn-sm">Remove</button></div>\`).join('');
        } else if (tab === 'pending') {
            let html = '';
            if (friendsData.incoming.length > 0) {
                html += '<div style="font-size:11px;font-weight:800;color:var(--text-3);letter-spacing:1px;text-transform:uppercase;padding:8px 0;">📬 Incoming</div>';
                html += friendsData.incoming.map(f => \`<div class="friend-row"><div class="friend-avatar">\${escapeHtml((f.display_name || f.username).charAt(0).toUpperCase())}</div><div style="flex:1;min-width:0;"><div class="friend-name">\${escapeHtml(f.display_name || f.username)}</div><div class="friend-tag">@\${escapeHtml(f.username)}#\${f.tag || '????'}</div></div><button onclick="acceptFriend('\${escapeHtml(f.username)}')" class="btn btn-primary btn-sm">✓</button><button onclick="declineFriend('\${escapeHtml(f.username)}')" class="btn btn-ghost btn-sm">✕</button></div>\`).join('');
            }
            if (friendsData.outgoing.length > 0) {
                html += '<div style="font-size:11px;font-weight:800;color:var(--text-3);letter-spacing:1px;text-transform:uppercase;padding:16px 0 8px 0;">📤 Sent</div>';
                html += friendsData.outgoing.map(f => \`<div class="friend-row" style="opacity:0.7;"><div class="friend-avatar">\${escapeHtml((f.display_name || f.username).charAt(0).toUpperCase())}</div><div style="flex:1;"><div class="friend-name">\${escapeHtml(f.display_name || f.username)}</div><div class="friend-tag">Waiting...</div></div></div>\`).join('');
            }
            if (!html) html = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-title">No pending requests</div></div>';
            content.innerHTML = html;
        } else if (tab === 'add') {
            content.innerHTML = \`<div style="max-width:600px;margin:0 auto;"><div style="font-size:14px;color:var(--text-2);margin-bottom:16px;">Enter username or ID</div><div style="display:flex;gap:10px;"><input type="text" id="friendInput" placeholder="Username or ID..." style="flex:1;"><button onclick="sendFriendReq()" class="btn btn-primary">Send Request</button></div><div style="margin-top:20px;"><div style="font-size:11px;font-weight:800;color:var(--text-3);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">Search</div><div id="searchResults"></div></div></div>\`;
            const inp = document.getElementById('friendInput');
            let timer;
            inp.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    const q = inp.value.trim();
                    if (q.length < 2) return document.getElementById('searchResults').innerHTML = '';
                    const r = await fetch('/api/search-users?q=' + encodeURIComponent(q));
                    const results = await r.json();
                    const el = document.getElementById('searchResults');
                    if (results.length === 0) return el.innerHTML = '<div style="color:var(--text-3);font-size:13px;">No users found</div>';
                    el.innerHTML = results.map(u => \`<div class="friend-row" style="margin-bottom:8px;"><div class="friend-avatar">\${escapeHtml((u.display_name || u.username).charAt(0).toUpperCase())}</div><div style="flex:1;"><div class="friend-name">\${escapeHtml(u.display_name || u.username)}</div><div class="friend-tag">@\${escapeHtml(u.username)}#\${u.tag || '????'}</div></div><button onclick="quickAdd('\${escapeHtml(u.username)}')" class="btn btn-primary btn-sm">+ Add</button></div>\`).join('');
                }, 300);
            });
            inp.addEventListener('keypress', e => { if (e.key === 'Enter') sendFriendReq(); });
        }
    }
    window.sendFriendReq = () => { const v = document.getElementById('friendInput').value.trim(); if (!v) return; socket.emit('send_friend_request', { from: me, to: v }); document.getElementById('friendInput').value = ''; };
    window.quickAdd = (username) => socket.emit('send_friend_request', { from: me, to: username });
    window.acceptFriend = (username) => socket.emit('accept_friend_request', { user: me, from: username });
    window.declineFriend = (username) => socket.emit('decline_friend_request', { user: me, from: username });
    window.removeFriend = (username) => { if (confirm('Remove ' + username + '?')) socket.emit('remove_friend', { user: me, friend: username }); };
    window.openDM = async (username) => {
        currentDM = username;
        document.getElementById('dmTitle').textContent = 'DM with ' + username;
        document.getElementById('dmModal').style.display = 'flex';
        const r = await fetch('/api/dm/' + encodeURIComponent(username));
        const messages = await r.json();
        const box = document.getElementById('dmMessages');
        box.innerHTML = messages.length === 0 ? '<div style="text-align:center;color:var(--text-3);font-size:13px;padding:20px;">Start the conversation!</div>' : messages.map(m => {
            const isMine = m.from_user === me;
            return \`<div style="display:flex;\${isMine ? 'justify-content:flex-end;' : ''}"><div style="max-width:75%;background:\${isMine ? 'linear-gradient(135deg,var(--red-1),var(--red-2))' : 'var(--bg-2)'};color:\${isMine ? '#fff' : 'var(--text-0)'};padding:10px 14px;border-radius:12px;font-size:13.5px;">\${escapeHtml(m.message)}</div></div>\`;
        }).join('');
        box.scrollTop = box.scrollHeight;
    };
    window.closeDM = () => { document.getElementById('dmModal').style.display = 'none'; currentDM = null; };
    document.getElementById('dmForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const msg = document.getElementById('dmInput').value.trim();
        if (!msg || !currentDM) return;
        socket.emit('send_dm', { from: me, to: currentDM, message: msg });
        document.getElementById('dmInput').value = '';
    });
    window.openProfileModal = async () => {
        const r = await fetch('/api/profile');
        const p = await r.json();
        document.getElementById('editDisplayName').value = p.display_name || me;
        document.getElementById('editBio').value = p.bio || '';
        document.getElementById('myFullId').textContent = '@' + p.username + '#' + (p.tag || '????');
        document.getElementById('profileModal').style.display = 'flex';
    };
    window.closeProfileModal = () => document.getElementById('profileModal').style.display = 'none';
    window.saveProfile = async () => {
        const display_name = document.getElementById('editDisplayName').value.trim();
        const bio = document.getElementById('editBio').value.trim();
        await fetch('/api/profile/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ display_name, bio }) });
        showToast('Profile updated!', 'success');
        closeProfileModal();
        loadMyProfile();
    };
    async function loadMyProfile() {
        const r = await fetch('/api/profile');
        const p = await r.json();
        document.getElementById('myDisplayName').textContent = p.display_name || me;
        document.getElementById('myTag').textContent = '#' + (p.tag || '????');
    }
    window.toggleFriendsSidebar = () => document.querySelector('.friends-sidebar').classList.toggle('mobile-open');
    socket.on('friend_request_sent', ({ to }) => showToast('Request sent to ' + to, 'success'));
    socket.on('friend_error', ({ error }) => showToast(error, 'error'));
    socket.on('friend_request_received', ({ from }) => { showToast(from + ' sent you a friend request!', 'success'); loadFriends(); });
    socket.on('friend_request_accepted', ({ by }) => { showToast(by + ' accepted your request!', 'success'); loadFriends(); });
    socket.on('friend_list_updated', () => loadFriends());
    socket.on('new_dm', (msg) => {
        if (currentDM && ((msg.from_user === me && msg.to_user === currentDM) || (msg.from_user === currentDM && msg.to_user === me))) openDM(currentDM);
        else if (msg.to_user === me) showToast('New message from ' + msg.from_user, 'success');
    });
    loadMyProfile();
    loadFriends();
    </script>

    <style>
    .friends-layout{display:grid;grid-template-columns:260px 1fr;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:16px;overflow:hidden;min-height:calc(100vh - 220px);position:relative}
    .friends-sidebar{background:var(--bg-0);border-right:1px solid var(--border-0);padding:12px;display:flex;flex-direction:column;gap:4px}
    .friend-tab{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:10px;background:transparent;border:none;color:var(--text-1);font-weight:700;font-size:13.5px;cursor:pointer;text-align:left;font-family:inherit}
    .friend-tab:hover{background:var(--bg-2);color:var(--text-0)}
    .friend-tab.active{background:var(--accent-dim);color:var(--accent)}
    .friend-badge{background:var(--accent);color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px;margin-left:auto}
    .friend-profile-mini{display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-2);border-radius:10px}
    .friend-avatar{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#fff;flex-shrink:0}
    .friends-main{display:flex;flex-direction:column;min-width:0}
    .friends-header{padding:16px 24px;border-bottom:1px solid var(--border-0);display:flex;align-items:center;justify-content:space-between;background:var(--bg-0)}
    .friends-content{flex:1;padding:24px;overflow-y:auto}
    .friend-row{display:flex;align-items:center;gap:14px;padding:14px 16px;background:linear-gradient(180deg,var(--bg-1),var(--bg-0));border:1px solid var(--border-0);border-radius:12px;margin-bottom:8px}
    .friend-row:hover{border-color:var(--border-1)}
    .friend-name{font-weight:700;font-size:14px;color:var(--text-0)}
    .friend-tag{font-size:11.5px;color:var(--text-3);font-weight:600;font-family:'JetBrains Mono',monospace}
    .chat-mobile-toggle{display:none;background:var(--bg-2);border:1px solid var(--border-0);color:var(--text-1);font-size:16px;width:34px;height:34px;border-radius:9px;cursor:pointer;align-items:center;justify-content:center}
    @media(max-width:768px){
        .friends-layout{grid-template-columns:1fr}
        .friends-sidebar{position:absolute;top:0;left:0;bottom:0;width:260px;z-index:10;transform:translateX(-100%);transition:transform 0.3s}
        .friends-sidebar.mobile-open{transform:translateX(0);box-shadow:20px 0 60px rgba(0,0,0,0.8)}
        .chat-mobile-toggle{display:flex}
        .friends-content{padding:16px}
        .friend-row{flex-wrap:wrap;gap:10px}
    }
    </style>`;
    res.send(renderLayout({ title: 'Friends', pageTitle: 'Friends', pageSubtitle: 'Manage your friends & DMs', content, user: req.session.user, activeNav: 'friends' }));
});

// ==================== FRIEND APIs ====================
app.get('/api/profile', requireLogin, async (req, res) => {
    try {
        const r = await pool.query('SELECT username, display_name, tag, bio, role, created_at FROM users WHERE username = $1', [req.session.user.username]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profile/update', requireLogin, async (req, res) => {
    try {
        const { display_name, bio } = req.body;
        await pool.query('UPDATE users SET display_name = $1, bio = $2 WHERE username = $3', [(display_name || req.session.user.username).substring(0, 50), (bio || '').substring(0, 200), req.session.user.username]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/friends', requireLogin, async (req, res) => {
    try {
        const me = req.session.user.username;
        const friends = await pool.query(`SELECT f.*, CASE WHEN f.user1 = $1 THEN f.user2 ELSE f.user1 END as friend_name FROM friends f WHERE (f.user1 = $1 OR f.user2 = $1) AND f.status = 'accepted'`, [me]);
        const pending = await pool.query(`SELECT f.*, f.requested_by, CASE WHEN f.user1 = $1 THEN f.user2 ELSE f.user1 END as other_name FROM friends f WHERE (f.user1 = $1 OR f.user2 = $1) AND f.status = 'pending'`, [me]);
        const outgoing = pending.rows.filter(p => p.requested_by === me);
        const incoming = pending.rows.filter(p => p.requested_by !== me);
        const getProfile = async (username) => {
            const r = await pool.query('SELECT username, display_name, tag, bio, role FROM users WHERE username = $1', [username]);
            return r.rows[0] || { username, display_name: username, tag: '????', bio: '', role: 'USER' };
        };
        const friendList = []; for (const f of friends.rows) friendList.push(await getProfile(f.friend_name));
        const incomingList = []; for (const f of incoming) incomingList.push(await getProfile(f.other_name));
        const outgoingList = []; for (const f of outgoing) outgoingList.push(await getProfile(f.other_name));
        res.json({ friends: friendList, incoming: incomingList, outgoing: outgoingList });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dm/:username', requireLogin, async (req, res) => {
    try {
        const me = req.session.user.username;
        const other = req.params.username;
        const result = await pool.query(`SELECT * FROM dm_messages WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1) ORDER BY created_at ASC LIMIT 100`, [me, other]);
        await pool.query('UPDATE dm_messages SET read = TRUE WHERE from_user = $1 AND to_user = $2', [other, me]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search-users', requireLogin, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.json([]);
        const result = await pool.query(`SELECT username, display_name, tag, role FROM users WHERE (LOWER(username) LIKE LOWER($1) OR LOWER(display_name) LIKE LOWER($1)) AND username != $2 LIMIT 10`, ['%' + q + '%', req.session.user.username]);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== ADMIN ====================
app.get('/admin', requireLogin, requireAdmin, async (req, res) => {
    try {
        const usersResult = await pool.query('SELECT id, username, role, created_at, display_name, tag FROM users ORDER BY created_at DESC');
        const users = usersResult.rows;
        const scriptsCountResult = await pool.query('SELECT owner, COUNT(*) as count FROM scripts GROUP BY owner');
        const scriptsCount = {};
        scriptsCountResult.rows.forEach(r => { scriptsCount[r.owner] = r.count; });
        let rows = '';
        users.forEach(u => {
            const count = scriptsCount[u.username] || 0;
            const isA = u.role === 'ADMIN';
            rows += `<a href="/admin/user/${encodeURIComponent(u.username)}" class="user-row"><div class="user-avatar ${isA ? 'user-avatar-admin' : ''}">${u.username.charAt(0)}</div><div class="user-row-info"><div class="user-row-name">${u.username} <span class="badge ${isA ? 'badge-admin' : 'badge-user'}">${u.role}</span></div><div class="user-row-meta">Joined ${new Date(u.created_at).toLocaleDateString()} · ${count} script${count !== 1 ? 's' : ''}</div></div><span class="btn btn-ghost btn-sm">View →</span></a>`;
        });
        const content = rows || `<div class="empty"><div class="empty-icon">◉</div><div class="empty-title">No users yet</div></div>`;
        res.send(renderLayout({ title: 'Admin', pageTitle: 'Admin Panel', pageSubtitle: `${users.length} user${users.length !== 1 ? 's' : ''} total`, content, user: req.session.user, activeNav: 'admin' }));
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/admin/user/:username', requireLogin, requireAdmin, async (req, res) => {
    try {
        const targetUser = req.params.username;
        const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [targetUser]);
        if (userResult.rows.length === 0) return res.status(404).send('Not found');
        const targetUserData = userResult.rows[0];
        const scriptsResult = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [targetUser]);
        const userScripts = scriptsResult.rows;
        const infoCard = `<div class="card" style="margin-bottom:22px;"><div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;"><div class="user-avatar ${targetUserData.role === 'ADMIN' ? 'user-avatar-admin' : ''}" style="width:56px;height:56px;border-radius:16px;font-size:22px;">${targetUser.charAt(0)}</div><div style="flex:1;"><div style="font-size:18px;font-weight:700;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">${targetUser} <span class="badge ${targetUserData.role === 'ADMIN' ? 'badge-admin' : 'badge-user'}">${targetUserData.role}</span></div><div style="font-size:12.5px;color:var(--text-2);margin-top:4px;">Joined ${new Date(targetUserData.created_at).toLocaleDateString()}</div></div></div></div>`;
        const scriptsHtml = userScripts.length === 0
            ? `<div class="empty"><div class="empty-icon">◈</div><div class="empty-title">No scripts</div></div>`
            : `<div class="scripts-grid">${userScripts.map(renderScriptCard).join('')}</div>`;
        res.send(renderLayout({ title: `${targetUser}'s Scripts`, pageTitle: `${targetUser}'s Scripts`, pageSubtitle: `${userScripts.length} script${userScripts.length !== 1 ? 's' : ''}`, content: infoCard + scriptsHtml, user: req.session.user, activeNav: 'admin', actions: `<a href="/admin" class="btn btn-ghost">← All Users</a>` }));
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== SOCKET.IO ====================
const voiceRooms = new Map();

io.on('connection', (socket) => {
    console.log('🔗 Connected:', socket.id);
    socket.on('register_user', ({ username }) => { socket.username = username; });

    socket.on('join_chat', async (data) => {
        try {
            const { username, role, channelId } = data;
            socket.username = username; socket.role = role; socket.channelId = channelId;
            socket.join('channel_' + channelId);
            const result = await pool.query('SELECT * FROM chat_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 50', [channelId]);
            socket.emit('chat_history', result.rows.reverse());
        } catch (e) { console.error(e); }
    });

    socket.on('switch_channel', async (data) => {
        try {
            const { channelId } = data;
            if (socket.channelId) socket.leave('channel_' + socket.channelId);
            socket.channelId = channelId;
            socket.join('channel_' + channelId);
            const result = await pool.query('SELECT * FROM chat_messages WHERE channel_id = $1 ORDER BY created_at DESC LIMIT 50', [channelId]);
            socket.emit('chat_history', result.rows.reverse());
        } catch (e) { console.error(e); }
    });

    socket.on('send_message', async (data) => {
        try {
            const { username, role, message, channelId } = data;
            if (!message || message.trim().length === 0) return;
            const result = await pool.query('INSERT INTO chat_messages (channel_id, username, role, message) VALUES ($1, $2, $3, $4) RETURNING *', [channelId, username, role, message.trim().substring(0, 500)]);
            io.to('channel_' + channelId).emit('new_message', result.rows[0]);
        } catch (e) { console.error(e); }
    });

    socket.on('delete_message', async (data) => {
        try {
            const { messageId, role, channelId } = data;
            if (role !== 'ADMIN') return;
            await pool.query('DELETE FROM chat_messages WHERE id = $1', [messageId]);
            io.to('channel_' + channelId).emit('message_deleted', { messageId });
        } catch (e) { console.error(e); }
    });

    // FRIENDS
    socket.on('send_friend_request', async (data) => {
        try {
            const { from, to } = data;
            if (!from || !to || from === to) return socket.emit('friend_error', { error: "Invalid request" });
            let targetUser = null;
            if (to.includes('#')) {
                const [name, tag] = to.split('#');
                const r = await pool.query('SELECT username FROM users WHERE LOWER(username) = LOWER($1) AND tag = $2', [name, tag]);
                if (r.rows.length > 0) targetUser = r.rows[0].username;
            } else {
                const r = await pool.query('SELECT username FROM users WHERE LOWER(username) = LOWER($1)', [to]);
                if (r.rows.length > 0) targetUser = r.rows[0].username;
            }
            if (!targetUser) return socket.emit('friend_error', { error: 'User not found' });
            const existing = await pool.query('SELECT * FROM friends WHERE (user1 = $1 AND user2 = $2) OR (user1 = $2 AND user2 = $1)', [from, targetUser]);
            if (existing.rows.length > 0) {
                if (existing.rows[0].status === 'accepted') return socket.emit('friend_error', { error: 'Already friends' });
                return socket.emit('friend_error', { error: 'Request already sent' });
            }
            const sorted = [from, targetUser].sort();
            await pool.query('INSERT INTO friends (user1, user2, status, requested_by) VALUES ($1, $2, $3, $4)', [sorted[0], sorted[1], 'pending', from]);
            const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.username === targetUser);
            if (targetSocket) targetSocket.emit('friend_request_received', { from });
            socket.emit('friend_request_sent', { to: targetUser });
        } catch (e) { console.error(e); socket.emit('friend_error', { error: 'Failed' }); }
    });

    socket.on('accept_friend_request', async (data) => {
        try {
            const { user, from } = data;
            const sorted = [user, from].sort();
            await pool.query('UPDATE friends SET status = $1 WHERE user1 = $2 AND user2 = $3', ['accepted', sorted[0], sorted[1]]);
            const fromSocket = Array.from(io.sockets.sockets.values()).find(s => s.username === from);
            if (fromSocket) fromSocket.emit('friend_request_accepted', { by: user });
            socket.emit('friend_list_updated');
        } catch (e) { console.error(e); }
    });

    socket.on('decline_friend_request', async (data) => {
        try {
            const { user, from } = data;
            const sorted = [user, from].sort();
            await pool.query('DELETE FROM friends WHERE user1 = $1 AND user2 = $2', [sorted[0], sorted[1]]);
            socket.emit('friend_list_updated');
        } catch (e) { console.error(e); }
    });

    socket.on('remove_friend', async (data) => {
        try {
            const { user, friend } = data;
            const sorted = [user, friend].sort();
            await pool.query('DELETE FROM friends WHERE user1 = $1 AND user2 = $2', [sorted[0], sorted[1]]);
            socket.emit('friend_list_updated');
        } catch (e) { console.error(e); }
    });

    socket.on('send_dm', async (data) => {
        try {
            const { from, to, message } = data;
            if (!message || message.trim().length === 0) return;
            const result = await pool.query('INSERT INTO dm_messages (from_user, to_user, message) VALUES ($1, $2, $3) RETURNING *', [from, to, message.trim().substring(0, 1000)]);
            const toSocket = Array.from(io.sockets.sockets.values()).find(s => s.username === to);
            if (toSocket) toSocket.emit('new_dm', result.rows[0]);
            socket.emit('new_dm', result.rows[0]);
        } catch (e) { console.error(e); }
    });

    // VOICE
    socket.on('join_voice', async (data) => {
        try {
            const { voiceChannelId, username, role } = data;
            if (socket.voiceChannelId) {
                socket.leave('voice_' + socket.voiceChannelId);
                const prevRoom = voiceRooms.get(socket.voiceChannelId);
                if (prevRoom) {
                    prevRoom.delete(socket.id);
                    if (prevRoom.size === 0) voiceRooms.delete(socket.voiceChannelId);
                    else io.to('voice_' + socket.voiceChannelId).emit('voice_participants', Array.from(prevRoom.values()));
                }
            }
            socket.voiceChannelId = voiceChannelId;
            socket.voiceUsername = username;
            socket.voiceRole = role;
            socket.join('voice_' + voiceChannelId);
            if (!voiceRooms.has(voiceChannelId)) voiceRooms.set(voiceChannelId, new Map());
            voiceRooms.get(voiceChannelId).set(socket.id, { socketId: socket.id, username, role, isStreaming: false, isMuted: false });
            const participants = Array.from(voiceRooms.get(voiceChannelId).values());
            io.to('voice_' + voiceChannelId).emit('voice_participants', participants);
            socket.emit('voice_existing_users', { users: participants.filter(p => p.socketId !== socket.id), self: socket.id });
        } catch (e) { console.error(e); }
    });

    socket.on('leave_voice', async () => {
        try {
            if (!socket.voiceChannelId) return;
            const vcId = socket.voiceChannelId;
            socket.leave('voice_' + vcId);
            const room = voiceRooms.get(vcId);
            if (room) {
                room.delete(socket.id);
                if (room.size === 0) voiceRooms.delete(vcId);
                else io.to('voice_' + vcId).emit('voice_participants', Array.from(room.values()));
            }
            socket.to('voice_' + vcId).emit('user_left_voice', { socketId: socket.id });
            socket.voiceChannelId = null;
        } catch (e) { console.error(e); }
    });

    socket.on('webrtc_offer', (data) => { io.to(data.targetSocketId).emit('webrtc_offer', { fromSocketId: socket.id, fromUsername: socket.voiceUsername, offer: data.offer, isScreenShare: data.isScreenShare }); });
    socket.on('webrtc_answer', (data) => { io.to(data.targetSocketId).emit('webrtc_answer', { fromSocketId: socket.id, answer: data.answer }); });
    socket.on('webrtc_ice_candidate', (data) => { io.to(data.targetSocketId).emit('webrtc_ice_candidate', { fromSocketId: socket.id, candidate: data.candidate }); });
    socket.on('toggle_mute', (data) => { if (!socket.voiceChannelId) return; const room = voiceRooms.get(socket.voiceChannelId); if (room && room.has(socket.id)) { room.get(socket.id).isMuted = data.isMuted; io.to('voice_' + socket.voiceChannelId).emit('voice_participants', Array.from(room.values())); } });
    socket.on('toggle_stream', (data) => { if (!socket.voiceChannelId) return; const room = voiceRooms.get(socket.voiceChannelId); if (room && room.has(socket.id)) { room.get(socket.id).isStreaming = data.isStreaming; io.to('voice_' + socket.voiceChannelId).emit('voice_participants', Array.from(room.values())); } });

    socket.on('disconnect', () => {
        if (socket.voiceChannelId) {
            const vcId = socket.voiceChannelId;
            const room = voiceRooms.get(vcId);
            if (room) {
                room.delete(socket.id);
                if (room.size === 0) voiceRooms.delete(vcId);
                else io.to('voice_' + vcId).emit('voice_participants', Array.from(room.values()));
            }
            socket.to('voice_' + vcId).emit('user_left_voice', { socketId: socket.id });
        }
        console.log('❌ Disconnected:', socket.id);
    });
});

// ==================== START ====================
server.listen(PORT, () => {
    console.log(`✅ ${BRAND_NAME} v31.0 — Servers + Channels + Voice + Screen + Friends`);
});
