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
        await pool.query(`CREATE TABLE IF NOT EXISTS scripts (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(100) NOT NULL DEFAULT 'Script', version VARCHAR(50) NOT NULL DEFAULT 'V1', real_content TEXT NOT NULL, public_content TEXT NOT NULL, token VARCHAR(64) UNIQUE NOT NULL, owner VARCHAR(50) NOT NULL, access_type VARCHAR(20) DEFAULT 'public', allowed_ids TEXT DEFAULT '[]', short_id VARCHAR(32), created_at TIMESTAMP DEFAULT NOW());`);
        await pool.query(`CREATE TABLE IF NOT EXISTS "session" ("sid" VARCHAR NOT NULL COLLATE "default", "sess" JSON NOT NULL, "expire" TIMESTAMP(6) NOT NULL, CONSTRAINT "session_pkey" PRIMARY KEY ("sid"));`);
        await pool.query(`CREATE TABLE IF NOT EXISTS execution_logs (id SERIAL PRIMARY KEY, script_id INTEGER NOT NULL, user_id VARCHAR(30) NOT NULL, username VARCHAR(100) DEFAULT '', allowed BOOLEAN DEFAULT FALSE, kicked BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW());`);

        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(50);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tag VARCHAR(4);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200) DEFAULT '';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS slug VARCHAR(100) DEFAULT 'Script';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS version VARCHAR(50) DEFAULT 'V1';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS access_type VARCHAR(20) DEFAULT 'public';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS allowed_ids TEXT DEFAULT '[]';`);
        await pool.query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS short_id VARCHAR(32);`);
        await pool.query(`UPDATE scripts SET slug = LOWER(REPLACE(name, ' ', '_')) WHERE slug = 'Script' OR slug IS NULL;`);
        await pool.query(`UPDATE scripts SET version = 'V1' WHERE version IS NULL;`);

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
        try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS scripts_short_id_idx ON scripts(short_id);`); } catch(e) {}

        const noTag = await pool.query(`SELECT id FROM users WHERE tag IS NULL`);
        for (const u of noTag.rows) {
            const tag = Math.floor(1000 + Math.random() * 9000).toString();
            await pool.query(`UPDATE users SET tag = $1, display_name = username WHERE id = $2`, [tag, u.id]);
        }

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

function getBaseUrl() {
    return process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
}

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
function versionDropdown(sv) { let o = ''; for (let i = 1; i <= 100; i++) { const v = 'V' + i; o += '<option value="' + v + '" ' + (v === sv ? 'selected' : '') + '>' + v + '</option>'; } return o; }
function getHtmlHead(t) { return '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"><meta name="theme-color" content="#0a0505"><title>' + t + ' · ' + BRAND_SHORT + '</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@500;600;700;800&display=swap" rel="stylesheet">'; }

const LAYOUT_STYLES = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg-0:#080404;--bg-1:#0e0707;--bg-2:#160b0b;--bg-3:#1f0f0f;--bg-glass:rgba(22,11,11,0.6);--border-0:rgba(255,255,255,0.06);--border-1:rgba(255,255,255,0.1);--border-2:rgba(255,59,59,0.3);--text-0:#ffffff;--text-1:#e0e0e0;--text-2:#9a9a9a;--text-3:#5a5a5a;--accent:#ff3b3b;--accent-bright:#ff5555;--accent-dim:rgba(255,59,59,0.12);--accent-glow:rgba(255,59,59,0.6);--red-1:#ff3b3b;--red-2:#cc0000;--purple:#b855ff;--green:#22c55e;--yellow:#ffbb44;--blue:#4a9eff}
html,body{height:100%;scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;background:var(--bg-0);color:var(--text-0);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden;min-height:100vh;position:relative}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 1000px 800px at 10% -10%,rgba(255,59,59,0.18) 0%,transparent 55%),radial-gradient(ellipse 1000px 800px at 90% 110%,rgba(184,85,255,0.12) 0%,transparent 55%),radial-gradient(ellipse 800px 600px at 50% 50%,rgba(74,158,255,0.06) 0%,transparent 60%);pointer-events:none;z-index:0;animation:bgPulse 15s ease-in-out infinite alternate}
@keyframes bgPulse{0%{opacity:0.7}50%{opacity:1}100%{opacity:0.7}}
body::after{content:'';position:fixed;inset:0;background-image:radial-gradient(circle at 20% 30%,rgba(255,59,59,0.08) 0%,transparent 2px),radial-gradient(circle at 80% 70%,rgba(184,85,255,0.08) 0%,transparent 2px);background-size:200px 200px,300px 300px;pointer-events:none;z-index:0;animation:bgFloat 20s linear infinite}
@keyframes bgFloat{0%{background-position:0 0,0 0}100%{background-position:200px 200px,300px 300px}}
a{color:inherit;text-decoration:none}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
input,textarea,select,button{-webkit-appearance:none;appearance:none}
.layout{display:flex;min-height:100vh;position:relative;z-index:1}
.sidebar{width:280px;background:linear-gradient(180deg,rgba(16,8,8,0.95),rgba(10,5,5,0.98));backdrop-filter:blur(30px) saturate(150%);border-right:1px solid var(--border-0);padding:24px 16px;display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50;transition:transform 0.4s cubic-bezier(0.4,0,0.2,1);box-shadow:4px 0 30px rgba(0,0,0,0.5)}
.sidebar-brand{display:flex;align-items:center;gap:12px;padding:8px 12px 22px 12px;border-bottom:1px solid var(--border-0);margin-bottom:20px}
.sidebar-logo{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-weight:900;font-size:17px;color:#fff;box-shadow:0 8px 24px rgba(255,59,59,0.4);animation:logoGlow 3s ease-in-out infinite alternate}
@keyframes logoGlow{0%{box-shadow:0 8px 24px rgba(255,59,59,0.4)}100%{box-shadow:0 8px 32px rgba(255,59,59,0.7)}}
.sidebar-brand-name{font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:16px;letter-spacing:-0.3px}
.sidebar-brand-sub{font-size:10px;color:var(--text-3);font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-top:3px}
.sidebar-nav{display:flex;flex-direction:column;gap:3px;flex:1;overflow-y:auto;padding:0 4px}
.nav-section-label{font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:1.5px;padding:18px 14px 8px 14px}
.nav-item{display:flex;align-items:center;gap:13px;padding:12px 14px;border-radius:12px;font-size:14px;font-weight:600;color:var(--text-1);transition:all 0.25s;cursor:pointer;min-height:46px;border:1px solid transparent}
.nav-item:hover{background:rgba(255,255,255,0.03);color:var(--text-0);transform:translateX(3px);border-color:var(--border-0)}
.nav-item.active{background:linear-gradient(90deg,var(--accent-dim),rgba(255,59,59,0.02));color:var(--accent-bright);border-color:rgba(255,59,59,0.2)}
.nav-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;filter:drop-shadow(0 0 4px rgba(255,59,59,0.3))}
.sidebar-footer{padding-top:16px;border-top:1px solid var(--border-0);margin-top:8px}
.user-card{display:flex;align-items:center;gap:11px;padding:12px;border-radius:12px;background:linear-gradient(135deg,rgba(255,59,59,0.05),rgba(184,85,255,0.05));border:1px solid var(--border-0);min-height:56px}
.user-avatar{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;flex-shrink:0;box-shadow:0 4px 12px rgba(255,59,59,0.35)}
.user-avatar-admin{background:linear-gradient(135deg,#ffaa00,#ff6600)}
.user-name{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-role{font-size:10px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:0.8px;margin-top:2px}
.main{flex:1;margin-left:280px;min-height:100vh;display:flex;flex-direction:column}
.topbar{height:72px;background:rgba(10,5,5,0.85);backdrop-filter:blur(30px) saturate(150%);border-bottom:1px solid var(--border-0);padding:0 32px;display:flex;align-items:center;justify-content:space-between;gap:20px;position:sticky;top:0;z-index:40}
.topbar-left{display:flex;align-items:center;gap:16px;min-width:0;flex:1}
.topbar-title{font-size:16px;font-weight:700;font-family:'Space Grotesk',sans-serif}
.topbar-right{display:flex;align-items:center;gap:10px}
.icon-btn{width:44px;height:44px;border-radius:12px;background:var(--bg-glass);border:1px solid var(--border-0);display:flex;align-items:center;justify-content:center;color:var(--text-1);font-size:16px;cursor:pointer;transition:all 0.25s}
.icon-btn:hover{background:var(--bg-3);color:var(--accent);border-color:rgba(255,59,59,0.3);transform:translateY(-2px)}
.content{padding:40px;flex:1;max-width:1500px;width:100%;margin:0 auto;animation:fadeIn 0.5s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.page-header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:36px}
.page-title{font-family:'Space Grotesk',sans-serif;font-size:38px;font-weight:800;letter-spacing:-1.5px;margin-bottom:8px;background:linear-gradient(135deg,#fff 0%,#ff5555 50%,#b855ff 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 0 30px rgba(255,59,59,0.3))}
.page-subtitle{font-size:14px;color:var(--text-2);font-weight:500}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;padding:12px 22px;border-radius:12px;font-weight:700;font-size:13.5px;cursor:pointer;white-space:nowrap;border:1px solid transparent;min-height:46px;transition:all 0.25s;text-decoration:none;font-family:inherit;position:relative;overflow:hidden}
.btn-primary{background:linear-gradient(135deg,var(--red-1),var(--red-2));color:#fff;box-shadow:0 6px 24px rgba(255,59,59,0.35)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 36px rgba(255,59,59,0.5)}
.btn-secondary{background:var(--bg-glass);color:var(--text-0);border-color:var(--border-1)}
.btn-secondary:hover{background:var(--bg-3);border-color:var(--border-2);transform:translateY(-2px)}
.btn-danger{background:rgba(255,59,59,0.1);color:#ff5555;border-color:rgba(255,59,59,0.25)}
.btn-danger:hover{background:rgba(255,59,59,0.2);transform:translateY(-2px)}
.btn-ghost{background:transparent;color:var(--text-1);border-color:var(--border-1)}
.btn-ghost:hover{background:var(--bg-2);color:var(--text-0);transform:translateY(-2px)}
.btn-sm{padding:10px 16px;font-size:12.5px;border-radius:10px;min-height:40px}
.btn-success{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;box-shadow:0 6px 24px rgba(34,197,94,0.35)}
.btn-success:hover{transform:translateY(-2px)}
.card{position:relative;background:linear-gradient(180deg,rgba(22,11,11,0.7),rgba(10,5,5,0.9));border:1px solid var(--border-0);border-radius:18px;padding:32px;backdrop-filter:blur(20px);transition:all 0.3s;overflow:hidden}
.card:hover{border-color:rgba(255,59,59,0.25);transform:translateY(-3px);box-shadow:0 20px 60px rgba(0,0,0,0.5)}
.form-group{margin-bottom:22px}
.form-label{display:block;font-size:11.5px;font-weight:800;color:var(--text-1);margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:22px}
input,textarea,select{width:100%;padding:14px 16px;background:rgba(0,0,0,0.4);border:1px solid var(--border-0);border-radius:12px;color:var(--text-0);font-size:15px;font-family:inherit;outline:none;min-height:52px;transition:all 0.25s}
input:focus,textarea:focus,select:focus{border-color:var(--accent);background:rgba(0,0,0,0.6);box-shadow:0 0 0 4px var(--accent-dim)}
input::placeholder,textarea::placeholder{color:var(--text-3)}
textarea{font-family:'JetBrains Mono',monospace;font-size:13px;resize:vertical;min-height:320px;line-height:1.6}
.badge{display:inline-flex;align-items:center;gap:4px;padding:4px 11px;border-radius:8px;font-size:10.5px;font-weight:800;border:1px solid transparent}
.badge-version{background:rgba(184,85,255,0.15);color:#d4a3ff;border-color:rgba(184,85,255,0.3)}
.badge-admin{background:rgba(255,170,0,0.15);color:#ffcc66;border-color:rgba(255,170,0,0.3)}
.badge-user{background:var(--accent-dim);color:var(--accent-bright);border-color:rgba(255,59,59,0.3)}
.badge-public{background:rgba(34,197,94,0.15);color:#4ade80;border-color:rgba(34,197,94,0.3)}
.badge-whitelist{background:rgba(255,170,0,0.15);color:#ffcc66;border-color:rgba(255,170,0,0.3)}
.badge-blocked{background:rgba(220,38,38,0.15);color:#ff6666;border-color:rgba(220,38,38,0.35)}
.empty{background:linear-gradient(180deg,rgba(22,11,11,0.5),rgba(10,5,5,0.8));border:1px dashed rgba(255,255,255,0.1);border-radius:20px;padding:80px 30px;text-align:center}
.empty-icon{width:90px;height:90px;border-radius:24px;background:linear-gradient(135deg,rgba(255,59,59,0.15),rgba(184,85,255,0.1));border:1px solid rgba(255,59,59,0.25);display:flex;align-items:center;justify-content:center;font-size:40px;margin:0 auto 24px;animation:floatIcon 3s ease-in-out infinite}
@keyframes floatIcon{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.empty-title{font-size:20px;font-weight:800;margin-bottom:10px;font-family:'Space Grotesk',sans-serif}
.empty-desc{font-size:14px;color:var(--text-2);margin-bottom:28px}
@keyframes toastIn{from{transform:translateX(400px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes toastOut{to{transform:translateX(400px);opacity:0}}
.toast{position:fixed;bottom:28px;right:28px;background:rgba(22,11,11,0.95);backdrop-filter:blur(30px);border:1px solid var(--border-1);color:var(--text-0);padding:16px 22px;border-radius:14px;font-weight:700;font-size:14px;box-shadow:0 24px 60px rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;gap:14px;animation:toastIn 0.4s}
.toast.hiding{animation:toastOut 0.3s forwards}
.toast::before{content:'';width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--green);box-shadow:0 0 16px var(--green)}
.toast.error::before{background:var(--accent);box-shadow:0 0 16px var(--accent-glow)}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{position:relative;background:linear-gradient(180deg,rgba(22,11,11,0.85),rgba(10,5,5,0.95));backdrop-filter:blur(40px);border:1px solid var(--border-1);border-radius:26px;padding:52px 44px;width:460px;max-width:100%;box-shadow:0 40px 120px rgba(0,0,0,0.8)}
.login-brand{display:flex;flex-direction:column;align-items:center;margin-bottom:38px;text-align:center}
.login-logo{width:84px;height:84px;border-radius:24px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:32px;color:#fff;margin-bottom:22px;box-shadow:0 12px 40px rgba(255,59,59,0.5);animation:logoGlow 3s ease-in-out infinite alternate}
.login-title{font-family:'Space Grotesk',sans-serif;font-size:28px;font-weight:800;margin-bottom:8px}
.login-sub{font-size:14px;color:var(--text-2)}
.login-card input{margin-bottom:14px;padding:15px 18px}
.login-card .btn-primary{width:100%;padding:16px;font-size:15px;margin-top:10px}
.login-msg{margin-top:18px;text-align:center;font-size:13px;font-weight:700;min-height:20px}
.login-msg.error{color:#ff6666}
.login-msg.success{color:#4ade80}
.login-link{display:block;text-align:center;margin-top:26px;font-size:14px;color:var(--accent-bright);font-weight:700}
.login-link:hover{color:#fff;text-shadow:0 0 20px var(--accent-glow)}
.menu-btn{display:none;width:44px;height:44px;border-radius:12px;background:var(--bg-glass);border:1px solid var(--border-0);align-items:center;justify-content:center;color:var(--text-1);font-size:20px}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(6px);z-index:45}
.overlay.active{display:block}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--border-1),rgba(255,59,59,0.3));border-radius:10px}
::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,var(--accent),var(--red-2))}
.copy-chip{display:inline-flex;align-items:center;gap:7px;background:rgba(0,0,0,0.5);border:1px solid var(--border-0);border-radius:9px;padding:6px 12px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--accent-bright);cursor:pointer;transition:all 0.25s;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy-chip:hover{background:rgba(255,59,59,0.1);border-color:var(--accent);color:#fff}
.id-list{display:flex;flex-direction:column;gap:12px;margin-bottom:16px}
.id-row{display:flex;align-items:center;gap:12px}
.id-row input{flex:1;font-family:'JetBrains Mono',monospace;font-size:14px}
.id-row .btn-remove{width:52px;height:52px;border-radius:12px;background:rgba(220,38,38,0.15);border:1px solid rgba(220,38,38,0.35);color:#ff5555;font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
.id-row .btn-remove:hover{background:rgba(220,38,38,0.3)}
.access-info{font-size:12.5px;color:var(--text-3);margin-top:10px;font-weight:500}
.access-info b{color:var(--accent-bright);font-weight:700}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;margin-bottom:36px}
.stat-card{background:linear-gradient(180deg,rgba(22,11,11,0.7),rgba(10,5,5,0.9));border:1px solid var(--border-0);border-radius:18px;padding:26px;transition:all 0.3s}
.stat-card:hover{transform:translateY(-4px);border-color:rgba(255,59,59,0.3)}
.stat-icon{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:18px;box-shadow:0 8px 24px rgba(255,59,59,0.4)}
.stat-label{font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px}
.stat-value{font-family:'Space Grotesk',sans-serif;font-size:34px;font-weight:800;letter-spacing:-1px}
.script-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:20px}
.log-item{display:flex;align-items:center;gap:14px;margin-bottom:10px;padding:16px 20px;border-radius:14px;border:1px solid;transition:all 0.25s}
.log-item:hover{transform:translateX(4px)}
.log-item.allowed{border-color:rgba(34,197,94,0.3);background:linear-gradient(90deg,rgba(34,197,94,0.05),transparent)}
.log-item.kicked{border-color:rgba(220,38,38,0.4);background:linear-gradient(90deg,rgba(220,38,38,0.08),transparent)}
.log-icon{width:40px;height:40px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:17px;flex-shrink:0}
.log-icon.allowed{background:linear-gradient(135deg,#22c55e,#16a34a)}
.log-icon.kicked{background:linear-gradient(135deg,#dc2626,#991b1b)}
@media(max-width:900px){.sidebar{transform:translateX(-100%);width:290px}.sidebar.open{transform:translateX(0)}.main{margin-left:0}.menu-btn{display:flex}.content{padding:28px 20px}.topbar{padding:0 20px;height:68px}.page-title{font-size:30px}.form-row{grid-template-columns:1fr}.script-grid{grid-template-columns:1fr}}
@media(max-width:600px){.content{padding:20px 16px}.page-title{font-size:26px}.card{padding:24px}.login-card{padding:40px 28px}.stat-value{font-size:28px}.toast{right:16px;bottom:16px;padding:14px 18px}}
`;

const TOAST_SCRIPT = `
function showToast(message,type){if(type===undefined)type='success';var e=document.querySelector('.toast');if(e)e.remove();var t=document.createElement('div');t.className='toast '+type;t.textContent=message;document.body.appendChild(t);setTimeout(function(){t.classList.add('hiding');setTimeout(function(){t.remove()},300)},2400)}
function copyToClipboard(text,btn,showMini){
    if(showMini===undefined)showMini=true;
    function doFallback(){try{var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.left='-9999px';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);return true;}catch(e){return false;}}
    function onSuccess(){if(btn){var old=btn.innerHTML;btn.innerHTML='✓ Copied!';setTimeout(function(){btn.innerHTML=old;},1400);}if(showMini){showToast('Copied!','success');}}
    function onFail(){if(btn){btn.innerHTML='✗ Failed';setTimeout(function(){btn.innerHTML='📋';},1400);}showToast('Copy failed','error');}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(onSuccess).catch(function(){if(doFallback())onSuccess();else onFail();});}
    else{if(doFallback())onSuccess();else onFail();}
}
function confirmDelete(token,name){if(confirm('🗑 Delete "'+name+'"?'))window.location.href='/delete/'+token}
function toggleSidebar(){document.querySelector('.sidebar').classList.toggle('open');document.querySelector('.overlay').classList.toggle('active')}
document.querySelectorAll('.nav-item').forEach(function(i){i.addEventListener('click',function(){if(window.innerWidth<=900){document.querySelector('.sidebar').classList.remove('open');document.querySelector('.overlay').classList.remove('active')}})});
var NotificationSound={ctx:null,enabled:true,init:function(){try{var saved=localStorage.getItem('zk_notif_sound');if(saved==='0')this.enabled=false;}catch(e){}},toggle:function(){this.enabled=!this.enabled;try{localStorage.setItem('zk_notif_sound',this.enabled?'1':'0');}catch(e){}this.updateUI();if(this.enabled)this.play();return this.enabled;},updateUI:function(){var btns=document.querySelectorAll('.notif-toggle-btn');for(var i=0;i<btns.length;i++){btns[i].textContent=this.enabled?'🔔':'🔕';if(this.enabled)btns[i].classList.remove('muted');else btns[i].classList.add('muted');}},ensureCtx:function(){if(!this.ctx){try{this.ctx=new(window.AudioContext||window.webkitAudioContext)();}catch(e){return null;}}if(this.ctx.state==='suspended'){this.ctx.resume().catch(function(){});}return this.ctx;},play:function(){if(!this.enabled)return;var ctx=this.ensureCtx();if(!ctx)return;try{var now=ctx.currentTime;var osc1=ctx.createOscillator();var gain1=ctx.createGain();osc1.type='sine';osc1.frequency.setValueAtTime(880,now);osc1.frequency.exponentialRampToValueAtTime(660,now+0.08);gain1.gain.setValueAtTime(0,now);gain1.gain.linearRampToValueAtTime(0.35,now+0.01);gain1.gain.exponentialRampToValueAtTime(0.001,now+0.18);osc1.connect(gain1);gain1.connect(ctx.destination);osc1.start(now);osc1.stop(now+0.2);}catch(e){}},alert:function(){if(!this.enabled)return;var ctx=this.ensureCtx();if(!ctx)return;try{var now=ctx.currentTime;for(var i=0;i<3;i++){var osc=ctx.createOscillator();var gain=ctx.createGain();osc.type='square';osc.frequency.setValueAtTime(1200,now+i*0.12);gain.gain.setValueAtTime(0.001,now+i*0.12);gain.gain.linearRampToValueAtTime(0.25,now+i*0.12+0.01);gain.gain.exponentialRampToValueAtTime(0.001,now+i*0.12+0.1);osc.connect(gain);gain.connect(ctx.destination);osc.start(now+i*0.12);osc.stop(now+i*0.12+0.11);}}catch(e){}}};
NotificationSound.init();
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
    var notifBtn = '<button class="icon-btn notif-toggle-btn" onclick="NotificationSound.toggle()" title="Notification Sound">🔔</button>';
    return '<!DOCTYPE html><html lang="en"><head>' + getHtmlHead(title) + '<style>' + LAYOUT_STYLES + '</style></head><body>' +
    '<div class="layout">' +
        '<aside class="sidebar" id="sidebar">' +
            '<div class="sidebar-brand"><div class="sidebar-logo">ZK</div><div class="sidebar-brand-text"><div class="sidebar-brand-name">' + BRAND_SHORT + '</div><div class="sidebar-brand-sub">By Zyrox-Kido</div></div></div>' +
            '<nav class="sidebar-nav">' +
                '<div class="nav-section-label">Workspace</div>' +
                '<a href="/" class="nav-item ' + (activeNav === 'dashboard' ? 'active' : '') + '"><span class="nav-icon">◈</span> Dashboard</a>' +
                '<a href="/create" class="nav-item ' + (activeNav === 'create' ? 'active' : '') + '"><span class="nav-icon">✦</span> Create Script</a>' +
                (isAdmin ? '<div class="nav-section-label">Administration</div><a href="/admin" class="nav-item ' + (activeNav === 'admin' ? 'active' : '') + '"><span class="nav-icon">♛</span> Admin Panel</a>' : '') +
            '</nav>' +
            '<div class="sidebar-footer"><a href="/logout" class="user-card"><div class="user-avatar ' + (isAdmin ? 'user-avatar-admin' : '') + '">' + user.username.charAt(0).toUpperCase() + '</div><div class="user-meta"><div class="user-name">' + user.username + '</div><div class="user-role">' + (isAdmin ? '♛ Admin' : 'Member') + '</div></div></a></div>' +
        '</aside>' +
        '<div class="overlay" onclick="toggleSidebar()"></div>' +
        '<div class="main">' +
            '<header class="topbar"><div class="topbar-left"><button class="menu-btn" onclick="toggleSidebar()">☰</button><div class="topbar-title">' + pageTitle + '</div></div><div class="topbar-right">' + notifBtn + '<a href="/logout" class="icon-btn">⏻</a></div></header>' +
            '<div class="content"><div class="page-header"><div><div class="page-title">' + pageTitle + '</div>' + (pageSubtitle ? '<div class="page-subtitle">' + pageSubtitle + '</div>' : '') + '</div>' + (actions || '') + '</div>' + content + '</div>' +
        '</div>' +
    '</div>' +
    '<script>' + TOAST_SCRIPT + '</script>' +
    '<script>setTimeout(function(){NotificationSound.updateUI();},50);</script>' +
    '</body></html>';
}

function renderScriptCard(s) {
    const baseUrl = getBaseUrl();
    const shortId = s.short_id || 'unknown';
    const version = s.version || 'V1';
    const accessType = s.access_type || 'public';
    let allowedCount = 0;
    try { allowedCount = JSON.parse(s.allowed_ids || '[]').length; } catch(e) {}
    const prettyUrl = baseUrl + '/api/raw?id=' + shortId;
    const loadstring = "loadstring(game:HttpGet('" + prettyUrl + "'))()";
    const accessBadge = accessType === 'whitelist'
        ? '<span class="badge badge-whitelist">🔒 Whitelist (' + allowedCount + ')</span>'
        : '<span class="badge badge-public">🌐 Public</span>';
    return '<div class="card"><div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px;"><div style="width:48px;height:48px;border-radius:13px;background:linear-gradient(135deg,var(--red-1),var(--red-2));display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">◈</div><div style="flex:1;min-width:0;"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:17px;font-weight:800;margin-bottom:8px;">' + s.name + '</div><div style="display:flex;gap:8px;flex-wrap:wrap;">' + accessBadge + '<span class="badge badge-version">' + version + '</span></div></div></div>' +
    '<div class="copy-chip" onclick="copyToClipboard(\'' + loadstring.replace(/'/g, "\\'") + '\',this,true)" style="margin-bottom:14px;width:100%;">🔗 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + loadstring + '</span> 📋</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="btn btn-primary btn-sm" onclick="copyToClipboard(\'' + loadstring.replace(/'/g, "\\'") + '\',this,true)">📋 Loadstring</button>' +
        '<a href="/logs/' + s.token + '" class="btn btn-secondary btn-sm">📊 Logs</a>' +
        '<a href="/edit/' + s.token + '" class="btn btn-ghost btn-sm">✎ Edit</a>' +
        '<button class="btn btn-danger btn-sm" onclick="confirmDelete(\'' + s.token + '\', \'' + s.name + '\')">🗑</button>' +
    '</div></div>';
}

function renderIdList(ids) {
    if (!ids || ids.length === 0) {
        return '<div class="id-row"><input type="text" class="id-input" placeholder="Roblox User ID" inputmode="numeric"><button type="button" class="btn-remove" onclick="removeIdRow(this)">×</button></div>';
    }
    return ids.map(function(id) {
        return '<div class="id-row"><input type="text" class="id-input" placeholder="Roblox User ID" inputmode="numeric" value="' + String(id).replace(/"/g, '&quot;') + '"><button type="button" class="btn-remove" onclick="removeIdRow(this)">×</button></div>';
    }).join('');
}

const ACCESS_FORM_SCRIPT = `
function updateAccessUI(){
    var sel = document.getElementById('accessType');
    var wrap = document.getElementById('idListWrap');
    var info = document.getElementById('accessInfo');
    if(!sel || !wrap) return;
    if(sel.value === 'whitelist'){
        wrap.style.display = 'block';
        if(info) info.innerHTML = '🔒 Only users in this list can execute the script.<br>Others will be <b>KICKED</b> automatically.<br><br>💡 <b>Ang User ID ay HINDI makikita ng player</b>.';
    } else {
        wrap.style.display = 'none';
        if(info) info.innerHTML = '🌐 Everyone can execute this script.';
    }
}
function addIdRow(){
    var list = document.getElementById('idList');
    if(!list) return;
    var row = document.createElement('div');
    row.className = 'id-row';
    row.innerHTML = '<input type="text" class="id-input" placeholder="Roblox User ID" inputmode="numeric"><button type="button" class="btn-remove" onclick="removeIdRow(this)">×</button>';
    list.appendChild(row);
}
function removeIdRow(btn){ var row = btn.parentNode; var list = row.parentNode; row.remove(); if(list.children.length === 0){ addIdRow(); } }
function collectIds(){ var inputs = document.querySelectorAll('.id-input'); var ids = []; for(var i = 0; i < inputs.length; i++){ var v = inputs[i].value.trim(); if(v && /^[0-9]+$/.test(v)) ids.push(v); } return ids; }
function prepareAccessSubmit(form){
    var sel = document.getElementById('accessType');
    var accEl = document.getElementById('accessTypeHidden');
    var idsEl = document.getElementById('allowedIdsHidden');
    if(!sel || !accEl || !idsEl) return true;
    accEl.value = sel.value;
    if(sel.value === 'whitelist'){
        var ids = collectIds();
        if(ids.length === 0){ alert('Please add at least one Roblox User ID.'); return false; }
        idsEl.value = JSON.stringify(ids);
    } else { idsEl.value = '[]'; }
    return true;
}
document.addEventListener('DOMContentLoaded', function(){ updateAccessUI(); });
`;

// ==================== AUTH ====================
app.get('/login', function(req, res) {
    res.send('<!DOCTYPE html><html><head>' + getHtmlHead('Login') + '<style>' + LAYOUT_STYLES + '</style></head><body>' +
    '<div class="login-wrap"><div class="login-card"><div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">Welcome back</div><div class="login-sub">Sign in to continue</div></div>' +
    '<form action="/login" method="POST"><input type="text" name="username" placeholder="Username" required autofocus><input type="password" name="password" placeholder="Password" required><button type="submit" class="btn btn-primary" style="width:100%">Sign In →</button></form>' +
    '<div class="login-msg error">' + (req.query.error ? 'Invalid credentials' : '') + '</div>' +
    '<div class="login-msg success">' + (req.query.registered ? 'Account created!' : '') + '</div>' +
    '<a href="/register" class="login-link">Create an account →</a>' +
    '</div></div><script>' + TOAST_SCRIPT + '</script></body></html>');
});
app.post('/login', async function(req, res) {
    try { const { username, password } = req.body; const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]); if (r.rows.length === 0) return res.redirect('/login?error=1'); const u = r.rows[0]; if (u.password !== password) return res.redirect('/login?error=1'); req.session.user = { username: u.username, role: u.role }; res.redirect('/'); } catch (e) { res.redirect('/login?error=1'); }
});
app.get('/register', function(req, res) {
    res.send('<!DOCTYPE html><html><head>' + getHtmlHead('Register') + '<style>' + LAYOUT_STYLES + '</style></head><body>' +
    '<div class="login-wrap"><div class="login-card"><div class="login-brand"><div class="login-logo">ZK</div><div class="login-title">Create account</div><div class="login-sub">Join ' + BRAND_SHORT + '</div></div>' +
    '<form action="/register" method="POST"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><input type="password" name="confirmPassword" placeholder="Confirm password" required><button type="submit" class="btn btn-primary" style="width:100%">Create Account →</button></form>' +
    '<div class="login-msg error">' + (req.query.error || '') + '</div><a href="/login" class="login-link">← Back to sign in</a>' +
    '</div></div><script>' + TOAST_SCRIPT + '</script></body></html>');
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
        const stats = '<div class="stat-grid">' +
            '<div class="stat-card"><div class="stat-icon">◈</div><div class="stat-label">Total Scripts</div><div class="stat-value">' + myScripts.length + '</div></div>' +
            '<div class="stat-card"><div class="stat-icon" style="background:linear-gradient(135deg,#b855ff,#8b3fff);">★</div><div class="stat-label">Role</div><div class="stat-value">' + (isAdmin ? 'Admin' : 'Member') + '</div></div>' +
            '<div class="stat-card"><div class="stat-icon" style="background:linear-gradient(135deg,#22c55e,#16a34a);">🔒</div><div class="stat-label">Whitelist Scripts</div><div class="stat-value">' + myScripts.filter(s => s.access_type === 'whitelist').length + '</div></div>' +
        '</div>';
        const scriptsHtml = myScripts.length === 0 ? '<div class="empty"><div class="empty-icon">◈</div><div class="empty-title">No scripts yet</div><div class="empty-desc">Create your first script to get started</div><a href="/create" class="btn btn-primary">✦ Create Script</a></div>' : '<div class="script-grid">' + myScripts.map(renderScriptCard).join('') + '</div>';
        res.send(renderLayout({ title: 'Dashboard', pageTitle: 'Dashboard', pageSubtitle: 'Manage your Lua scripts', content: stats + scriptsHtml, user: req.session.user, activeNav: 'dashboard', actions: '<a href="/create" class="btn btn-primary">✦ New Script</a>' }));
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/create', requireLogin, function(req, res) {
    const accessUI = '<div class="form-group"><label class="form-label">🔒 Access Type</label><select id="accessType" onchange="updateAccessUI()"><option value="public">🌐 Public (Everyone)</option><option value="whitelist">🔒 Whitelist (Specific User IDs only)</option></select></div>' +
    '<div class="form-group" id="idListWrap" style="display:none;"><label class="form-label">👤 Roblox User IDs</label><div class="id-list" id="idList">' + renderIdList([]) + '</div><button type="button" class="btn btn-success btn-sm" onclick="addIdRow()">+ Add User</button><div class="access-info" id="accessInfo"></div></div>' +
    '<input type="hidden" name="access_type" id="accessTypeHidden" value="public"><input type="hidden" name="allowed_ids" id="allowedIdsHidden" value="[]">';
    const content = '<div class="card" style="max-width:980px"><form action="/create" method="POST" onsubmit="return prepareAccessSubmit(this)"><div class="form-row"><div class="form-group"><label class="form-label">📝 Script Name</label><input type="text" name="name" required autofocus placeholder="e.g., Kido Hub v1"></div><div class="form-group"><label class="form-label">🏷 Version</label><select name="version" required>' + versionDropdown('V1') + '</select></div></div>' + accessUI + '<div class="form-group"><label class="form-label">📜 Lua Code</label><textarea name="content" required placeholder="-- Isulat ang Lua script dito..."></textarea></div><div style="display:flex;gap:12px;flex-wrap:wrap;"><button type="submit" class="btn btn-primary">💾 Save Script</button><a href="/" class="btn btn-ghost">Cancel</a></div></form></div>' + '<script>' + ACCESS_FORM_SCRIPT + '</script>';
    res.send(renderLayout({ title: 'Create', pageTitle: 'Create Script', pageSubtitle: 'Add a new Lua script', content: content, user: req.session.user, activeNav: 'create' }));
});
app.post('/create', requireLogin, async function(req, res) {
    try {
        const name = req.body.name;
        const version = req.body.version || 'V1';
        const content = req.body.content;
        const access_type = req.body.access_type || 'public';
        let allowed_ids = req.body.allowed_ids || '[]';
        try { JSON.parse(allowed_ids); } catch(e) { allowed_ids = '[]'; }
        const slug = makeSlug(name);
        const token = crypto.randomBytes(16).toString('hex');
        let shortId; let exists = true;
        while (exists) {
            shortId = crypto.randomBytes(5).toString('hex');
            const c = await pool.query('SELECT id FROM scripts WHERE short_id = $1', [shortId]);
            exists = c.rows.length > 0;
        }
        await pool.query('INSERT INTO scripts (name, slug, version, real_content, public_content, token, owner, access_type, allowed_ids, short_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [name, slug, version, content, obfuscateScript(content), token, req.session.user.username, access_type, allowed_ids, shortId]);
        res.redirect('/');
    } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/edit/:token', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (r.rows.length === 0) return res.status(404).send("Not found");
        const s = r.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied");
        const escaped = s.real_content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let ids = [];
        try { ids = JSON.parse(s.allowed_ids || '[]'); } catch(e) { ids = []; }
        const accessType = s.access_type || 'public';
        const baseUrl = getBaseUrl();
        const prettyUrl = baseUrl + '/api/raw?id=' + s.short_id;
        const loadstring = "loadstring(game:HttpGet('" + prettyUrl + "'))()";
        const accessUI = '<div style="background:linear-gradient(135deg,rgba(74,158,255,0.08),rgba(74,158,255,0.02));border:1px solid rgba(74,158,255,0.25);border-radius:14px;padding:20px;margin-bottom:24px;"><div style="font-size:10px;font-weight:800;color:#7cc0ff;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;">🔗 RAW LINK (ROBLOX)</div><div class="copy-chip" onclick="copyToClipboard(\'' + loadstring.replace(/'/g, "\\'") + '\',this,true)" style="background:rgba(74,158,255,0.1);border-color:rgba(74,158,255,0.3);font-size:11.5px;width:100%;">' + loadstring + ' 📋</div></div>' +
        '<div class="form-group"><label class="form-label">📝 Script Name</label><input type="text" name="name" value="' + s.name.replace(/"/g, '&quot;') + '" required></div>' +
        '<div class="form-group"><label class="form-label">🏷 Version</label><select name="version" required>' + versionDropdown(s.version) + '</select></div>' +
        '<div class="form-group"><label class="form-label">🔒 Access Type</label><select id="accessType" onchange="updateAccessUI()"><option value="public"' + (accessType === 'public' ? ' selected' : '') + '>🌐 Public (Everyone)</option><option value="whitelist"' + (accessType === 'whitelist' ? ' selected' : '') + '>🔒 Whitelist (Specific User IDs only)</option></select></div>' +
        '<div class="form-group" id="idListWrap" style="display:' + (accessType === 'whitelist' ? 'block' : 'none') + ';"><label class="form-label">👤 Roblox User IDs</label><div class="id-list" id="idList">' + renderIdList(ids) + '</div><button type="button" class="btn btn-success btn-sm" onclick="addIdRow()">+ Add User</button><div class="access-info" id="accessInfo"></div></div>' +
        '<input type="hidden" name="access_type" id="accessTypeHidden" value="' + accessType + '"><input type="hidden" name="allowed_ids" id="allowedIdsHidden" value="' + (s.allowed_ids || '[]').replace(/"/g, '&quot;') + '">';
        const content = '<div class="card" style="max-width:980px"><form action="/edit/' + s.token + '" method="POST" onsubmit="return prepareAccessSubmit(this)">' + accessUI + '<div class="form-group"><label class="form-label">📜 Script Content (Lua)</label><textarea name="content" required style="min-height:400px;">' + escaped + '</textarea></div><div style="display:flex;gap:12px;flex-wrap:wrap;"><button type="submit" class="btn btn-primary">💾 Save Changes</button><a href="/" class="btn btn-ghost">Cancel</a></div></form></div>' + '<script>' + ACCESS_FORM_SCRIPT + '</script>';
        res.send(renderLayout({ title: 'Edit', pageTitle: 'Edit Script', pageSubtitle: 'Update your script', content: content, user: req.session.user, activeNav: 'dashboard' }));
    } catch (e) { res.status(500).send('Error'); }
});
app.post('/edit/:token', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (r.rows.length === 0) return res.status(404).send("Not found");
        const s = r.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied");
        const name = req.body.name;
        const version = req.body.version || 'V1';
        const content = req.body.content;
        const access_type = req.body.access_type || 'public';
        let allowed_ids = req.body.allowed_ids || '[]';
        try { JSON.parse(allowed_ids); } catch(e) { allowed_ids = '[]'; }
        const slug = makeSlug(name);
        await pool.query('UPDATE scripts SET name = $1, slug = $2, version = $3, real_content = $4, public_content = $5, access_type = $6, allowed_ids = $7 WHERE token = $8', [name, slug, version, content, obfuscateScript(content), access_type, allowed_ids, req.params.token]);
        res.redirect('/');
    } catch (e) { res.status(500).send('Error'); }
});

app.get('/delete/:token', requireLogin, async function(req, res) {
    try { const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]); if (r.rows.length === 0) return res.redirect('/'); const s = r.rows[0]; const isAdmin = req.session.user.role === 'ADMIN'; if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send("Denied"); await pool.query('DELETE FROM scripts WHERE token = $1', [req.params.token]); await pool.query('DELETE FROM execution_logs WHERE script_id = $1', [s.id]); res.redirect('/'); } catch (e) { res.status(500).send('Error'); }
});

// ==================== AUTO-INJECT ROUTE ====================
app.get('/api/raw', async function(req, res) {
    try {
        const shortId = req.query.id;
        if (!shortId) return res.status(400).send("-- [ShieldHub] Invalid request --");

        const r = await pool.query('SELECT * FROM scripts WHERE short_id = $1 LIMIT 1', [shortId]);
        if (r.rows.length === 0) return res.status(404).send("-- [ShieldHub] Script not found --");
        const s = r.rows[0];

        const accessType = s.access_type || 'public';
        const originalScript = s.real_content;

        // === PUBLIC ===
        // Lahat pwede, walang check, walang kick
        if (accessType === 'public') {
            await pool.query('INSERT INTO execution_logs (script_id, user_id, username, allowed, kicked) VALUES ($1, $2, $3, $4, $5)', [s.id, 'public', '', true, false]);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(originalScript);
        }

        // === WHITELIST ===
        let allowedIds = [];
        try { allowedIds = JSON.parse(s.allowed_ids || '[]'); } catch(e) { allowedIds = []; }

        // Kung walang IDs sa whitelist, ibigay lang (walang check)
        if (allowedIds.length === 0) {
            await pool.query('INSERT INTO execution_logs (script_id, user_id, username, allowed, kicked) VALUES ($1, $2, $3, $4, $5)', [s.id, 'no_ids', '', true, false]);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.send(originalScript);
        }

        // May IDs — I-inject ang ID check
        const allowedIdsJson = JSON.stringify(allowedIds);

        const protectedScript = `-- [ShieldHub Protection] Do not remove.
local _sh_allowed = ${allowedIdsJson}
local _sh_userId = tostring(game.Players.LocalPlayer.UserId)
local _sh_username = game.Players.LocalPlayer.Name
local _sh_ok = false

for _, id in ipairs(_sh_allowed) do
    if tostring(id) == _sh_userId then
        _sh_ok = true
        break
    end
end

pcall(function()
    local _sh_req = (syn and syn.request) or (http and http.request) or http_request or request
    if _sh_req then
        _sh_req({
            Url = "${getBaseUrl()}/api/log-execution",
            Method = "POST",
            Headers = {["Content-Type"] = "application/json"},
            Body = game:GetService("HttpService"):JSONEncode({
                token = "${s.token}",
                userId = _sh_userId,
                username = _sh_username,
                allowed = _sh_ok
            })
        })
    end
end)

if not _sh_ok then
    pcall(function()
        game.Players.LocalPlayer:Kick("[ShieldHub] 🚫 You are NOT whitelisted for this script.")
    end)
    return
end

-- ============================================
-- ORIGINAL SCRIPT: ${s.name}
-- ============================================

${originalScript}
`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(protectedScript);
    } catch (e) { console.error(e); res.status(500).send("-- [ShieldHub] Server Error --"); }
});

app.post('/api/log-execution', async function(req, res) {
    try {
        const { token, userId, username, allowed } = req.body;
        if (!token || !userId) return res.json({ ok: false });
        const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [token]);
        if (r.rows.length === 0) return res.json({ ok: false });
        const s = r.rows[0];
        await pool.query('INSERT INTO execution_logs (script_id, user_id, username, allowed, kicked) VALUES ($1, $2, $3, $4, $5)', [s.id, String(userId), username || '', !!allowed, !allowed]);
        return res.json({ ok: true });
    } catch (e) { console.error(e); res.json({ ok: false }); }
});

// ==================== LOGS VIEW ====================
app.get('/logs/:token', requireLogin, async function(req, res) {
    try {
        const r = await pool.query('SELECT * FROM scripts WHERE token = $1', [req.params.token]);
        if (r.rows.length === 0) return res.status(404).send('Not found');
        const s = r.rows[0];
        const isAdmin = req.session.user.role === 'ADMIN';
        if (s.owner !== req.session.user.username && !isAdmin) return res.status(403).send('Denied');
        const logs = await pool.query('SELECT * FROM execution_logs WHERE script_id = $1 ORDER BY created_at DESC LIMIT 200', [s.id]);
        let total = logs.rows.length;
        let allowedCount = logs.rows.filter(function(l){ return l.allowed; }).length;
        let kickedCount = logs.rows.filter(function(l){ return l.kicked; }).length;
        const statCards = '<div class="stat-grid">' +
            '<div class="stat-card"><div class="stat-icon">📊</div><div class="stat-label">Total Executions</div><div class="stat-value">' + total + '</div></div>' +
            '<div class="stat-card"><div class="stat-icon" style="background:linear-gradient(135deg,#22c55e,#16a34a);">✓</div><div class="stat-label">Allowed</div><div class="stat-value" style="color:#4ade80">' + allowedCount + '</div></div>' +
            '<div class="stat-card"><div class="stat-icon" style="background:linear-gradient(135deg,#dc2626,#991b1b);">🚫</div><div class="stat-label">Kicked</div><div class="stat-value" style="color:#ff5555">' + kickedCount + '</div></div>' +
        '</div>';
        let rows = logs.rows.map(function(l) {
            const cls = l.allowed ? 'allowed' : 'kicked';
            const icon = l.allowed ? '✓' : '✗';
            const badge = l.allowed ? '<span class="badge badge-public">✓ Allowed</span>' : '<span class="badge badge-blocked">🚫 Kicked</span>';
            return '<div class="log-item ' + cls + '"><div class="log-icon ' + cls + '">' + icon + '</div><div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:14px;">' + (l.username || 'Unknown') + ' <span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--text-3);">(' + l.user_id + ')</span></div><div style="font-size:11.5px;color:var(--text-3);margin-top:3px;">' + new Date(l.created_at).toLocaleString() + '</div></div>' + badge + '</div>';
        }).join('');
        const content = '<div class="card" style="margin-bottom:24px;"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;"><div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;font-weight:800;letter-spacing:1.5px;margin-bottom:6px;">📊 Execution Logs</div><div style="font-family:\'Space Grotesk\',sans-serif;font-weight:800;font-size:22px;">' + s.name + '</div></div><div style="display:flex;gap:10px;flex-wrap:wrap;"><button onclick="location.reload()" class="btn btn-secondary btn-sm">🔄 Refresh</button><a href="/edit/' + s.token + '" class="btn btn-ghost btn-sm">← Back</a></div></div></div>' + statCards + (rows || '<div class="empty"><div class="empty-icon">📊</div><div class="empty-title">No logs yet</div><div class="empty-desc">Logs will appear when users execute this script</div></div>');
        res.send(renderLayout({ title: 'Logs', pageTitle: 'Execution Logs', pageSubtitle: s.name, content: content, user: req.session.user, activeNav: 'dashboard' }));
    } catch (e) { res.status(500).send('Error'); }
});

// ==================== ADMIN ====================
app.get('/admin', requireLogin, requireAdmin, async function(req, res) {
    try {
        const u = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
        let rows = '';
        u.rows.forEach(function(x) { const isA = x.role === 'ADMIN'; rows += '<a href="/admin/user/' + encodeURIComponent(x.username) + '" class="card" style="display:flex;align-items:center;gap:16px;margin-bottom:12px;cursor:pointer;text-decoration:none;"><div class="user-avatar ' + (isA ? 'user-avatar-admin' : '') + '">' + x.username.charAt(0) + '</div><div style="flex:1;"><div style="font-weight:700;font-size:15px;">' + x.username + ' <span class="badge ' + (isA ? 'badge-admin' : 'badge-user') + '">' + x.role + '</span></div><div style="font-size:12px;color:var(--text-2);margin-top:3px;">Joined ' + new Date(x.created_at).toLocaleDateString() + '</div></div><span class="btn btn-ghost btn-sm">View →</span></a>'; });
        const content = rows || '<div class="empty"><div class="empty-icon">◉</div><div class="empty-title">No users</div></div>';
        res.send(renderLayout({ title: 'Admin', pageTitle: 'Admin Panel', pageSubtitle: u.rows.length + ' users', content: content, user: req.session.user, activeNav: 'admin' }));
    } catch (e) { res.status(500).send('Error'); }
});
app.get('/admin/user/:username', requireLogin, requireAdmin, async function(req, res) {
    try { const t = req.params.username; const s = await pool.query('SELECT * FROM scripts WHERE owner = $1 ORDER BY created_at DESC', [t]); const content = s.rows.length === 0 ? '<div class="empty"><div class="empty-icon">◈</div><div class="empty-title">No scripts</div></div>' : '<div class="script-grid">' + s.rows.map(renderScriptCard).join('') + '</div>'; res.send(renderLayout({ title: t, pageTitle: t + '\'s Scripts', pageSubtitle: s.rows.length + ' scripts', content: content, user: req.session.user, activeNav: 'admin', actions: '<a href="/admin" class="btn btn-ghost">← All Users</a>' })); } catch (e) { res.status(500).send('Error'); }
});

// ==================== SERVER START ====================
server.listen(PORT, function() {
    console.log('✅ ' + BRAND_NAME + ' — ShieldHub v2.0');
    console.log('🎨 Pinagandang UI + Auto-Inject User ID Check');
    console.log('🔒 Public = Lahat pwede | Whitelist (may IDs) = Auto-Kick kung wala');
});
