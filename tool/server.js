// 咸鱼喵喵 · 截图辅助工具 —— 本地服务
//
// 职责：
//   1. 给浏览器提供一个控制面板页面
//   2. 通过 CDP 把面板上的操作转成游戏里的 JavaScript
//   3. 管存档备份 / 恢复、沙盒副本
//
// 安全：
//   - 只监听 127.0.0.1，同一个 WiFi 下的别人连不上
//   - 不改程序和素材；明确选择后可保存/还原存档，复制沙盒。

const http = require('http');
const fs = require('fs');
const path = require('path');

const { CdpClient } = require('./lib/cdp.js');
const { OPS } = require('./lib/ops.js');
const { storyPosition } = require('./lib/story-position');
const { loadAll } = require('./lib/data.js');
const { StoryCache } = require('./lib/story-cache');
const SAFETY = require('./lib/safety');
const FILES = require('./lib/files');
const { assertGamesStopped } = require('./lib/processes');

// ---------- 路径与配置 ----------
const TOOL_DIR = __dirname;
const AITEMP_DIR = path.resolve(TOOL_DIR, '..');            // aitemp/
const LEGACY_GAME_DIR = path.resolve(AITEMP_DIR, '..');     // 旧布局的游戏根目录
const WEB_DIR = path.join(TOOL_DIR, 'web');
const BACKUP_DIR = path.join(AITEMP_DIR, 'backups');
const CONFIG_FILE = path.join(TOOL_DIR, 'config.json');

// 沙盒默认位置：和游戏同一个盘的根目录下。
// ⚠️ 不要写死具体盘符 —— 别人的游戏不一定装在 L 盘。
//    放在盘根是为了**避开 Steam 库**（放库里 Steam 会扫到，云同步也可能够得着）。
const DEFAULT_SANDBOX = path.join(path.parse(LEGACY_GAME_DIR).root, 'Nyaruru_shots');

const DEFAULTS = {
    cdpPort: 9223,                                          // 沙盒实例的调试端口
    sandboxDir: DEFAULT_SANDBOX,
    webPort: 8787,
};

function loadConfig() { return SAFETY.readConfig(CONFIG_FILE, DEFAULTS, LEGACY_GAME_DIR); }
const CONFIG = loadConfig();
const GAME_DIR = CONFIG.gameDir || LEGACY_GAME_DIR;
function classifyGameDir(dir) {
    if (!dir) return 'unknown';
    try {
        if (SAFETY.samePath(dir, GAME_DIR)) return 'original';
        if (SAFETY.samePath(dir, CONFIG.sandboxDir)) return 'sandbox';
    } catch { return 'unknown'; }
    return 'other';
}
/** 校验并写回 config.json。只接受已知字段，避免前端传进来的杂项污染配置 */
function saveConfig(patch) {
    if (sandboxJob.running) throw new Error('沙盒复制期间不能修改配置');
    const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => ['cdpPort', 'webPort', 'sandboxDir'].includes(k)));
    const next = SAFETY.validateConfig({ ...CONFIG, ...allowed }, GAME_DIR);
    // 面板端口修改要重启，因此也不能让 CDP 占用当前正在监听的旧端口。
    if (server?.listening && next.cdpPort === server.address().port) throw new Error('调试端口与当前正在使用的面板端口冲突，请先重启面板');
    const temp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temp, CONFIG_FILE);
    const portChanged = next.cdpPort !== CONFIG.cdpPort;
    const webPortChanged = next.webPort !== CONFIG.webPort;
    Object.assign(CONFIG, next);
    if (portChanged) { cdp.close(); cdp.port = CONFIG.cdpPort; erasedCache.clear(); storyCache.reset(); }
    return { config: CONFIG, cdpReconnected: portChanged, webPortNeedsRestart: webPortChanged };
}

// ---------- 静态数据（启动时载入一次）----------
let DATA;
try {
    DATA = loadAll(AITEMP_DIR);
    console.log(`[数据] 开关 ${DATA.stats.switches} · 变量 ${DATA.stats.variables} · 地图 ${DATA.stats.maps}`);
    console.log(`[数据] 触发点 ${DATA.stats.triggersUnique} 条（可跳转 ${DATA.stats.triggersActionable} 条）· 常用开关 ${DATA.stats.commonSwitches} 个`);
} catch (e) {
    console.error('[数据] 载入失败:', e.message);
    console.error('       请确认 aitemp/out/triggers.csv 与 aitemp/unpacked/data/ 存在。');
    process.exit(1);
}

const cdp = new CdpClient(CONFIG.cdpPort);
const storyCache = new StoryCache(cdp, OPS, DATA.triggers);

// "mapId:eventId" → 该事件是否被游戏自己抹除（_erased）。
// 每次只保留当前地图扫描结果，避免切换存档后沿用旧标记。
const erasedCache = new Map();

// ---------- 存档备份 ----------
const backupSaves = (dir, label) => FILES.backupSaves(BACKUP_DIR, dir, label);
const listBackups = () => FILES.listBackups(BACKUP_DIR);
let sandboxJob = { running: false, done: false, error: null, message: '', startedAt: 0 };
function sandboxExists() { return FILES.sandboxStatus(GAME_DIR, CONFIG.sandboxDir, AITEMP_DIR).ready; }
function createSandbox() {
    if (sandboxJob.running) throw new Error('已有拷贝任务在进行中');
    const dest = CONFIG.sandboxDir;
    const promise = FILES.copySandbox(GAME_DIR, dest, AITEMP_DIR);
    sandboxJob = { running: true, done: false, error: null, message: '正在拷贝并验证…', startedAt: Date.now(), dest };
    promise.then(() => { sandboxJob = { ...sandboxJob, running: false, done: true, message: '拷贝及验证完成' }; }, e => {
        sandboxJob = { ...sandboxJob, running: false, done: false, error: e.message, message: '拷贝失败，不能启动该副本' };
    });
    return { started: true, dest };
}
function targetDir(body) {
    if (!['original', 'sandbox'].includes(body.target)) throw new Error('必须明确选择原版或沙盒目标');
    return body.target === 'sandbox' ? CONFIG.sandboxDir : GAME_DIR;
}
let operationTail = Promise.resolve();
const offlineActions = new Set(['/api/config', '/api/backup', '/api/restore-backup', '/api/sandbox', '/api/shutdown', '/api/story-text']);
const getRoutes = new Set(['/api/status', '/api/snapshot', '/api/trainer', '/api/item-icons', '/api/encyclopedia', '/api/world-map', '/api/combat', '/api/maps', '/api/switches', '/api/config', '/api/ground', '/api/events/lost', '/api/events', '/api/triggers', '/api/backups', '/api/sandbox/status', '/api/health', '/api/story-text']);
async function identity() {
    const r = await cdp.evalJson(OPS.selfPath());
    if (!r?.ok) throw new Error(r?.error || '无法识别游戏实例');
    return { ...r, dir: r.gameDir, kind: classifyGameDir(r.gameDir), context: `${cdp.generation}:${r.mapToken}` };
}
function guarded(script, token) {
    return `(async()=>{ const i=JSON.parse(await ${OPS.selfPath()}); if(i.mapToken!==${JSON.stringify(token)}) return JSON.stringify({ok:false,error:'地图或存档已经变化，请刷新后重试'}); return await ${script}; })()`;
}

// ---------- 工具函数 ----------
function readBody(req) {
    return new Promise((resolve, reject) => {
        let buf = '';
        req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('请求 JSON 格式错误')); } });
        req.on('error', reject);
        req.on('aborted', () => reject(new Error('请求已取消')));
    });
}

function sendJson(res, obj, code = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(WEB_DIR, rel);
    // 防止 ../ 穿越到 web 目录之外
    if (!SAFETY.contains(WEB_DIR, file)) { res.writeHead(403); res.end('forbidden'); return; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
}

// ---------- 路由 ----------
async function handleApi(req, res, urlPath, query) {
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, { ok: false, error: '不支持的请求方法' }, 405);
    if (req.method === 'GET' && !getRoutes.has(urlPath)) return sendJson(res, { ok: false, error: '修改操作必须使用 POST' }, 405);
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return sendJson(res, { ok: false, error: '拒绝跨站修改请求' }, 403);
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (req.method === 'POST') {
        const task = operationTail.then(() => executeApi(req, res, urlPath, body));
        operationTail = task.catch(() => {});
        return task;
    }
    return executeApi(req, res, urlPath, body);
}
async function executeApi(req, res, urlPath, body) {
    let current = null;
    if (req.method === 'POST' && !offlineActions.has(urlPath)) {
        current = await identity();
        if (!['sandbox', 'original'].includes(current.kind)) throw new Error('无法确认游戏身份，停止修改操作');
        if (!body.context || body.context !== current.context) throw new Error('连接、地图或存档已变化，请刷新后重试');
    }
    const game = async script => {
        if (current && current.context.split(':')[0] !== String(cdp.generation)) throw new Error('连接已变化，操作已取消');
        return cdp.evalJson(current ? guarded(script, current.mapToken) : script);
    };
    switch (urlPath) {
        case '/api/encyclopedia/travel':return sendJson(res,await game(OPS.catalogTravel(body.mapId,body.eventId)));
        case '/api/world-map/travel':return sendJson(res,await game(OPS.worldMapTravel(body.mapId,body.cellX,body.cellY,body.page)));
        case '/api/combat': {
            if(req.method==='GET')current=await identity();
            const r=await game(OPS.combat(req.method==='POST'?body:null));return sendJson(res,{...r,context:current.context});
        }
        case '/api/shutdown': {
            if (sandboxJob.running) throw new Error('沙盒仍在复制，请等待任务结束再停止面板');
            sendJson(res, { ok: true });
            setTimeout(() => { cdp.close(); server.close(() => { if (require.main === module) process.exit(0); }); }, 100);
            return;
        }
        case '/api/health': return sendJson(res, { ok: true, toolDir: TOOL_DIR, version: 2, config: CONFIG });
        // --- 连接状态 ---
        case '/api/status': {
            const alive = await cdp.isAlive();
            // 检测到调试端口就顺手建立会话（首次之后会复用，开销很小），
            // 这样面板一打开就能显示"已连接"，而不是等到第一次操作
            let connected = false;
            if (alive) {
                try { await cdp.connect(); connected = !!cdp.sessionId; } catch { connected = false; }
            }

            // 顺手问一句：游戏窗口自己是从哪个目录加载的？
            // 面板据此显示"当前连接：沙盒 / 原版"，把"以为在沙盒、其实改了原版"这种
            // 将实际实例身份显示给用户；约定见 tool/开发文档.md。
            let gameSelf = null;
            if (connected) { try { gameSelf = await identity(); } catch { connected = false; } }
            if (!connected) {
                erasedCache.clear(); cdp.close(); storyCache.reset();
            } else { void storyCache.ensure().catch(() => {}); }
            const storyText = storyCache.status();
            return sendJson(res, {
                ok: true,
                gameRunning: alive,
                connected,
                cdpPort: CONFIG.cdpPort,
                gameDir: GAME_DIR,
                sandboxDir: CONFIG.sandboxDir,
                sandboxExists: sandboxExists(),
                sandboxJob,
                gameSelf,
                stats: { ...DATA.stats, storyLoaded: storyText.count, triggersWithLine: storyText.triggersWithLine },
                dataMode: 'runtime', storyText,
                context: gameSelf?.context || null,
            });
        }

        // --- 游戏状态快照 ---
        case '/api/world-map': {
            if (req.method !== 'GET') throw new Error('世界地图为只读功能');
            const before = await identity();
            const r = await cdp.evalJson(guarded(OPS.worldMap(), before.mapToken));
            return sendJson(res, { ...r, context: before.context });
        }
        case '/api/encyclopedia': {
            if (req.method !== 'GET') throw new Error('百科为只读功能');
            const before = await identity();
            const r = await cdp.evalJson(guarded(OPS.encyclopedia(), before.mapToken));
            return sendJson(res, { ...r, context: before.context });
        }
        case '/api/item-icons': {
            if (req.method !== 'GET') throw new Error('图标为只读功能');
            const before = await identity();
            const r = await cdp.evalJson(guarded(OPS.itemIcons(), before.mapToken));
            return sendJson(res, { ...r, context:before.context });
        }
        case '/api/trainer': {
            if (req.method === 'GET') current = await identity();
            const r = await game(OPS.trainer(req.method === 'POST' ? body : null));
            return sendJson(res, { ...r, context: current.context });
        }
        case '/api/snapshot': {
            const snap = await game(OPS.snapshot());
            return sendJson(res, snap);
        }

        // --- 地图列表 ---
        case '/api/maps':
            return sendJson(res, { ok: true, maps: DATA.maps });

        // --- 开关 ---
        case '/api/switches': {
            let values = {};
            try { values = (await game(OPS.readSwitches())).values || {}; } catch { /* 没连上就只给名字 */ }
            const common = new Set(DATA.commonSwitchIds);
            return sendJson(res, {
                ok: true,
                switches: DATA.switches.map(s => ({ ...s, common: common.has(s.id) })),
                values,
                connected: Object.keys(values).length > 0,
            });
        }
        case '/api/switch': {
            const r = await game(OPS.setSwitch(body.id, body.value));
            return sendJson(res, r);
        }
        // 批量设置开关（"一键前往"用：一次把该对话需要的条件全部打开）
        case '/api/switches/set': {
            const pairs = Array.isArray(body.pairs) ? body.pairs : [];
            if (!pairs.length) return sendJson(res, { ok: true, applied: 0 });
            return sendJson(res, await game(OPS.setSwitches(pairs)));
        }

        // --- 传送 ---
        // body.float 默认 true：传送后进入"悬浮安全模式"（暂停重力 + 穿墙），
        // 避免落进坑里触发游戏的坠落复位。详见 ops.js 里 teleport 的注释。
        case '/api/teleport': {
            const r = await game(OPS.teleport(body.x, body.y, {
                float: body.float !== false,
                // mapId 不传或与当前地图相同 → 地图内定位；
                // 不同 → 走 reserveTransfer 跨地图（见 ops.js 的 teleport 注释）
                mapId: body.mapId ?? null,
            }));
            return sendJson(res, r);
        }
        case '/api/nudge': return sendJson(res, await game(OPS.nudge(body.dx, body.dy, body.pixels)));

        // --- 直接播放一段剧情序列 ---
        // 绕开地图事件与开关条件，用于通关存档上复现"错过就没了"的对话
        case '/api/story/start': {
            const position = storyPosition(body);
            const tp = await game(OPS.teleport(position.x, position.y, { mapId: body.mapId, story: body }));
            if (!tp.ok) return sendJson(res, tp);
            const next = await identity();
            if (next.context.split(':')[0] !== current.context.split(':')[0] || !SAFETY.samePath(next.dir, current.dir)) throw new Error('传送期间连接已变化');
            current = next;
            const r = await game(body.mode === 'scene' ? OPS.runStoryScene(body.storyId, body.eventId, body.pageIndex) : OPS.playStory(body.storyId));
            r.positionNote = tp.positionNote;
            // 传送及补角色会临时开启悬浮；过场准备完成后恢复安全落地。
            // 放在 runStoryScene 之后，避免其避让角色逻辑再次开启悬浮。
            if (r.ok && body.mode === 'scene') {
                r.landing = await game(OPS.land());
                if (!r.landing.ok) r.landingWarning = '当前落点未能自动落地：' + r.landing.error;
                else if (r.landing.warning) r.landingWarning = r.landing.warning;
            }
            return sendJson(res, r);
        }
        case '/api/story/goto': {
            // 验证所有参数后才修改开关，并把开关及传送放在同一排队任务中。
            const position = storyPosition(body);
            const teleport = OPS.teleport(position.x, position.y, { mapId: body.mapId, story: body });
            const pairs = Array.isArray(body.pairs) ? body.pairs : [];
            if (pairs.some(p => !Array.isArray(p) || !DATA.switches.some(s => s.id === p[0]) || typeof p[1] !== 'boolean')) throw new Error('开关参数无效');
            if (pairs.length) {
                const r = await game(OPS.setSwitches(pairs));
                if (!r.ok) return sendJson(res, r);
            }
            return sendJson(res, await game(teleport));
        }
        case '/api/story/play':
            return sendJson(res, await game(OPS.playStory(body.storyId)));

        // --- 运行整段过场（含 NPC 站位与演出），而不是只念台词 ---
        case '/api/story/scene':
            return sendJson(res, await game(OPS.runStoryScene(body.storyId)));

        // --- 关掉当前的消息窗口（截完图收尾用）---
        case '/api/story/close': return sendJson(res, await game(OPS.closeMessage()));

        // --- 莉莉娅显示 / 隐藏 ---
        case '/api/lily': return sendJson(res, await game(OPS.setLily(body.show !== false)));

        // --- 拍照辅助：隐藏 / 显示 对话框、立绘、HUD ---
        // 只藏不关，随时能显示回来（要"真的关掉对话"请用 /api/story/close）
        case '/api/ui-hidden':
            return sendJson(res, await game(OPS.setUiHidden({
                message: typeof body.message === 'boolean' ? body.message : null,
                artwork: typeof body.artwork === 'boolean' ? body.artwork : null,
                hud: typeof body.hud === 'boolean' ? body.hud : null,
            })));

        // --- 落地：从悬浮状态站到实地上（会先探测脚下是否安全）---
        case '/api/land': return sendJson(res, await game(OPS.land()));

        // --- 探测脚下地形（"落地"按钮的预检，也可单独用）---
        case '/api/ground': return sendJson(res, await game(OPS.probeGround()));

        // --- 配置 ---
        case '/api/config': {
            if (req.method === 'POST') {
                try {
                    const r = saveConfig(body);
                    return sendJson(res, { ok: true, ...r, defaults: DEFAULTS });
                } catch (e) {
                    return sendJson(res, { ok: false, error: String(e.message) }, 400);
                }
            }
            return sendJson(res, { ok: true, config: CONFIG, defaults: DEFAULTS, configFile: CONFIG_FILE });
        }

        // --- 作弊开关 ---
        case '/api/gravity': return sendJson(res, await game(OPS.setGravity(!!body.on)));
        case '/api/invincible': return sendJson(res, await game(OPS.setInvincible(!!body.on)));
        case '/api/noclip': return sendJson(res, await game(OPS.setNoclip(!!body.on)));
        case '/api/restore': return sendJson(res, await game(OPS.restoreAll()));

        // --- 场景还原（摆拍）：扫描本图丢失的角色 → 强行切页让它们出现 ---
        // 静态摆拍与撤销由 photo-state 管理，自动和手动存档照常，仅提示风险。
        case '/api/events/lost': {
            const before = await identity();
            const r = await cdp.evalJson(guarded(OPS.scanLostEvents(), before.mapToken));
            return sendJson(res, { ...r, context: before.context });
        }
        case '/api/events/force-page':
            return sendJson(res, await game(OPS.forcePage(body.eventId, body.page)));
        // 取消本图所有"钉住"的页号，恢复游戏自己的选页
        case '/api/events/unpin':
            return sendJson(res, await game(OPS.unpinPages()));

        case '/api/events/restore-cast':
            // includeHidden=false（默认）只恢复"被抹除"的，那些是明确的该在不在；
            // true 才连"游戏有意隐藏"的一起拉出来 —— 会凭空多出人物，界面上要警告
            return sendJson(res, await game(OPS.restoreLostCast({
                includeHidden: body.includeHidden === true,
            })));

        // --- 存"拍照专用档" ---
        // ⚠️ 会覆盖该槽位原有进度，所以这里先自动备份整个存档目录再存
        case '/api/save-photo': {
            // 先在服务端做个粗校验，避免参数写错时白备份一次存档目录
            // （真正的合法性由游戏侧按 DataManager.maxSavefiles() 判断）
            const slot = Number(body.slot);
            if (!Number.isInteger(slot) || slot < 1 || slot > 23) {
                return sendJson(res, { ok: false, error: `槽位必须是 1~23 之间的整数（0 是自动存档槽，不能存）` }, 400);
            }
            const target = targetDir(body);
            if (current.kind !== body.target || !SAFETY.samePath(current.dir, target) || !current.saveDir || !SAFETY.samePath(current.saveDir, path.join(target, 'save'))) throw new Error('实际连接的游戏或存档目录与所选目标不一致，未保存');
            const backup = backupSaves(target, 'presave');
            const r = await game(OPS.savePhotoSlot(slot));
            return sendJson(res, { ...r, target: current.saveDir, safetyBackup: backup.name });
        }

        // --- 事件列表（当前地图）---
        // 把事件页里 call_story 的故事序号翻译成台词，这样列表上显示的是
        // 「台词」— 说话人 而不是 EV058 这种内部编号（见开发文档第 6 节）
        case '/api/events': {
            await storyCache.ensure();
            const before = await identity();
            const r = await cdp.evalJson(guarded(OPS.listEvents(), before.mapToken));
            r.context = before.context;
            if (r && r.ok) {
                for (const ev of r.events) {
                    const lines = (ev.storyIds || [])
                        .map(id => ({ id, ...(storyCache.get(id) || {}) }))
                        .filter(s => s.first);
                    ev.lines = lines;
                    // 有剧情的事件优先展示，UI 也据此排序
                    ev.hasStory = (ev.storyIds || []).length > 0;
                }
            }
            return sendJson(res, r);
        }

        // --- 剧情触发点 ---
        // 顺便抓一次**当前地图**的"抹除状态"并缓存（开发文档第 6 节）：
        // 被游戏自己抹除的事件页号钉死在 -1，走过去也触发不了，
        // 只标记当前地图的本次扫描，不跨地图或存档保留旧标记。
        case '/api/story-text': {
            await storyCache.ensure({ force: body.refresh === true });
            return sendJson(res, { ok: true, ...storyCache.status() });
        }
        case '/api/triggers': {
            await storyCache.ensure();
            erasedCache.clear();
            let scannedMap = null;
            if (await cdp.isAlive()) {
                try {
                    const ev = await game(OPS.listEvents());
                    if (ev && ev.ok && ev.mapId) {
                        scannedMap = ev.mapId;
                        for (const e of ev.events) {
                            erasedCache.set(`${ev.mapId}:${e.id}`, !!e.erased);
                        }
                    }
                } catch { /* 没连上就只给静态数据 */ }
            }
            const triggers = DATA.triggers.map(t => {
                const key = (t.mapId !== null && t.eventId !== '') ? `${t.mapId}:${t.eventId}` : null;
                const known = key !== null && erasedCache.has(key);
                const line = storyCache.get(t.storyId);
                return { ...t, triggerX: t.x, triggerY: t.y, ...storyPosition(t), line: line?.first || '', speaker: line?.speaker || '',
                    lineCount: line?.count || 0, lines: line?.lines || [], searchText: line?.searchText || '',
                    erased: known ? erasedCache.get(key) : null };
            });
            return sendJson(res, { ok: true, triggers, scannedMap, knownErased: erasedCache.size, storyText: storyCache.status() });
        }

        // --- 存档备份 ---
        case '/api/backups':
            return sendJson(res, { ok: true, backups: listBackups(), backupDir: BACKUP_DIR });
        case '/api/backup': {
            const target = targetDir(body);
            const label = body.target;
            return sendJson(res, { ok: true, ...backupSaves(target, label) });
        }
        case '/api/restore-backup': {
            if (!body.confirm) return sendJson(res, { ok: false, error: '需要确认（会覆盖当前存档）' }, 400);
            const target = targetDir(body);
            await assertGamesStopped();
            return sendJson(res, { ok: true, ...FILES.restoreBackup(BACKUP_DIR, body.name, target) });
        }

        // --- 沙盒 ---
        case '/api/sandbox': return sendJson(res, { ok: true, ...createSandbox() });
        case '/api/sandbox/status': return sendJson(res, { ok: true, ...sandboxJob, exists: sandboxExists() });

        default:
            return sendJson(res, { ok: false, error: '未知接口: ' + urlPath }, 404);
    }
}

const server = http.createServer(async (req, res) => {
    try {
        const u = new URL(req.url, `http://127.0.0.1:${CONFIG.webPort}`);
        if (u.pathname.startsWith('/api/')) await handleApi(req, res, u.pathname, u.searchParams);
        else serveStatic(res, u.pathname);
    } catch (e) {
        sendJson(res, { ok: false, error: String(e && e.message || e) }, 500);
    }
});

// 只监听回环地址 —— 局域网内的其他人访问不到
if (require.main === module) server.listen(CONFIG.webPort, '127.0.0.1', async () => {
    fs.writeFileSync(path.join(TOOL_DIR, '.server-runtime.json'), JSON.stringify({ port: server.address().port, pid: process.pid }));
    console.log('');
    console.log('  咸鱼喵喵 · 截图辅助工具');
    console.log('  ────────────────────────────────────────');
    console.log(`  控制面板:  http://127.0.0.1:${CONFIG.webPort}`);
    console.log(`  游戏目录:  ${GAME_DIR}`);
    console.log(`  沙盒目录:  ${CONFIG.sandboxDir}  ${sandboxExists() ? '(已存在)' : '(未创建)'}`);
    console.log(`  调试端口:  ${CONFIG.cdpPort}`);
    const alive = await cdp.isAlive();
    console.log(`  游戏连接:  ${alive ? '已检测到调试端口' : '未检测到（请先启动游戏）'}`);
    console.log('  ────────────────────────────────────────');
    console.log('  按 Ctrl+C 退出');
    console.log('');
});

// 退出时主动断开 CDP，不给游戏留悬挂连接
if (require.main === module) process.on('SIGINT', () => {
    console.log('\n正在退出…');
    cdp.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
});

module.exports = { server, cdp, CONFIG, saveConfig, handleApi, executeApi, identity, storyCache };
