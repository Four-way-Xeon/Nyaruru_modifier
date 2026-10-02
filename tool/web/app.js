// 咸鱼喵喵 · 截图辅助工具 —— 控制面板逻辑

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let SWITCHES = [];              // [{id, name, common}]
let SWITCH_BY_NAME = new Map(); // 开关名 → id
let TRIGGERS = [];
let STORY_TEXT_STATE = { state: 'disconnected', loaded: false, revision: -1, connection: null };
let TRIGGER_REQUEST = 0;
function clearRuntimeText() {
    ++TRIGGER_REQUEST;
    TRIGGERS = TRIGGERS.map(t => ({ ...t, line: '', speaker: '', lineCount: 0, lines: [], searchText: '', erased: null }));
    EVENTS = []; EVENTS_CONTEXT = null;
    renderEvents(); renderTriggers();
}
function applyStoryState(state) {
    const previous = STORY_TEXT_STATE;
    if ((!state.loaded && previous.loaded) || state.connection !== previous.connection) clearRuntimeText();
    STORY_TEXT_STATE = state;
    renderStoryTextHint();
    if (state.loaded && (state.revision !== previous.revision || state.connection !== previous.connection)) loadTriggers();
}
function renderStoryTextHint() {
    const el = $('#story-text-hint');
    el.hidden = STORY_TEXT_STATE.loaded;
    const messages = {
        disconnected: '连接游戏后会自动读取台词。现在可按地图、坐标或开关名搜索。',
        waiting: '已连接，等待游戏的故事表就绪…', loading: '正在读取台词…',
        retrying: '故事表尚未就绪，稍后自动重试。',
        error: '台词读取失败，自动重试已停止。可点“重新读取台词”再试。',
    };
    el.textContent = (messages[STORY_TEXT_STATE.state] || '') + (STORY_TEXT_STATE.error ? ' 原因：' + STORY_TEXT_STATE.error : '');
}

let SHOW_ALL_SWITCHES = false;
let CURRENT_CONTEXT = null;
let CURRENT_GAME = null;
let EVENTS_CONTEXT = null;
let LOST_CONTEXT = null;
let STATUS_BUSY = false;
let LAST_MAP = null;            // 上一次看到的地图号，用来检测换图

let TRAINER = null, TRAINER_READING = false, TRAINER_WRITING = false, TRAINER_REVISION = 0;

// ---------- 基础工具 ----------
async function api(path, body) {
    if (body) body = { context: CURRENT_CONTEXT, ...body };
    const opt = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {};
    const r = await fetch('/api' + path, opt);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '操作失败');
    return j;
}

let toastTimer = null;
function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast ' + kind; }, 3600);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 角色与背包 ----------
const STAT_NAMES = { coin: '金币', hp: '生命 HP', sp: '体力 SP', zp: '能量 ZP' };
const ITEM_TYPES = { consumables: '消耗品', weapons: '武器', stones: '宝石', ornaments: '饰品', joycoin: '特殊材料', hpst: '特殊材料', skillst: '特殊材料' };
function invalidateTrainer(message = '请先连接游戏并进入地图') {
    TRAINER = null; TRAINER_REVISION++;
    $('#trainer-role').textContent = message;
    $('#trainer-stats').replaceChildren();
    $('#trainer-items').innerHTML = `<div class="empty">${esc(message)}</div>`;
}
function renderTrainer(resetInputs = false) {
    if (!TRAINER) return;
    $('#trainer-role').textContent = `当前操作角色：${TRAINER.role}`;
    for (const [field, label] of Object.entries(STAT_NAMES)) {
        const stat = TRAINER.stats[field];
        let row = $('#trainer-stat-' + field);
        if (!row) {
            row = document.createElement('div'); row.className = 'trainer-stat'; row.id = 'trainer-stat-' + field;
            row.innerHTML = `<b>${label}</b> <span class="meta" data-current></span><div class="row"><input type="number" min="0" step="1" aria-label="${label}目标值"><button data-set>设值</button><button data-lock>设值并锁定</button></div>`;
            $('#trainer-stats').appendChild(row);
            row.querySelector('[data-set]').onclick = () => changeTrainer({ action: 'stat', field, value: numericInput(row.querySelector('input')) });
            row.querySelector('[data-lock]').onclick = () => changeTrainer({ action: 'stat', field,
                locked: !TRAINER.stats[field].locked, value: numericInput(row.querySelector('input')) });
            resetInputs = true;
        }
        const shown = Math.round(stat.value * 100) / 100;
        row.querySelector('[data-current]').textContent = `${shown} / ${stat.max}${stat.locked ? ' · 已锁定' : ''}`;
        const input = row.querySelector('input'); input.max = stat.max;
        if (resetInputs) input.value = stat.locked ? Math.min(stat.target, stat.max) : Math.floor(stat.value);
        row.querySelector('[data-lock]').textContent = stat.locked ? '解除锁定' : '设值并锁定';
    }
    if (!$('#trainer-items').contains(document.activeElement) || resetInputs) renderTrainerItems();
    trainerDisabled();
}
function numericInput(input) { return input.value.trim() === '' ? null : Number(input.value); }
function trainerDisabled() {
    $$('#trainer-stats button, #trainer-stats input, #trainer-items button, #trainer-items input').forEach(el => { el.disabled = TRAINER_WRITING || !TRAINER; });
    $('#trainer-refresh').disabled = TRAINER_WRITING || TRAINER_READING;
}
function renderTrainerItems() {
    if (!TRAINER) return;
    const query = $('#trainer-search').value.trim().toLowerCase(), category = $('#trainer-category').value;
    const items = TRAINER.items.filter(item =>
        (!category || category === item.type || (category === 'special' && ITEM_TYPES[item.type] === '特殊材料')) &&
        (!$('#trainer-owned').checked || item.count > 0) && `${item.name} ${item.desc} ${item.id}`.toLowerCase().includes(query));
    $('#trainer-items').innerHTML = items.map(item => {
        const counted = item.type === 'consumables' || ITEM_TYPES[item.type] === '特殊材料';
        const max = item.type === 'consumables' && $('#trainer-overcap').checked ? 99999 : item.max;
        return `<div class="item" data-type="${item.type}" data-id="${item.id}"><div class="grow"><div class="name">${esc(item.name)} ${item.equipped ? '<span class="tag ok">已装备</span>' : ''}</div><div class="meta">${ITEM_TYPES[item.type]} #${item.id} · 已有 ${item.count}${counted ? ` · 上限 ${item.max}` : ''}</div><div class="meta">${esc(item.desc)}</div></div>${counted ? `<input type="number" min="0" max="${max}" step="1" value="${item.count}" aria-label="${esc(item.name)}数量"><button data-count>设置数量</button>` : `<button data-owned="${item.count ? 0 : 1}">${item.count ? '移除' : '添加'}</button>`}</div>`;
    }).join('') || '<div class="empty">没有匹配物品</div>';
    trainerDisabled();
}
async function loadTrainer(resetInputs = false) {
    if (TRAINER_READING || TRAINER_WRITING || !CURRENT_CONTEXT) return;
    TRAINER_READING = true; trainerDisabled();
    const revision = TRAINER_REVISION, context = CURRENT_CONTEXT;
    try {
        const result = await api('/trainer');
        if (revision !== TRAINER_REVISION || context !== CURRENT_CONTEXT || result.context !== context) return;
        const changed = TRAINER?.subject !== result.subject;
        TRAINER = result; renderTrainer(resetInputs || changed);
    } catch (e) {
        if (revision === TRAINER_REVISION) invalidateTrainer('读取失败：' + e.message);
    } finally { TRAINER_READING = false; trainerDisabled(); }
}
async function changeTrainer(body) {
    if (!TRAINER || TRAINER_WRITING) return;
    const context = TRAINER.context, subject = TRAINER.subject, revision = ++TRAINER_REVISION;
    TRAINER_WRITING = true; trainerDisabled();
    try {
        const result = await api('/trainer', { ...body, context, subject });
        if (revision !== TRAINER_REVISION || CURRENT_CONTEXT !== context) return;
        TRAINER = result; renderTrainer(true);
        toast(body.locked === false ? '已解除锁定' : '已修改', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { TRAINER_WRITING = false; trainerDisabled(); }
}
$('#trainer-refresh').onclick = () => loadTrainer(true);
$('#trainer-search').oninput = renderTrainerItems;
['trainer-category', 'trainer-owned', 'trainer-overcap'].forEach(id => { $('#' + id).onchange = renderTrainerItems; });
$('#trainer-items').onclick = ev => {
    const button = ev.target.closest('button');
    if (!button) return;
    const row = button.closest('[data-type]');
    changeTrainer({ action: 'item', type: row.dataset.type, id: Number(row.dataset.id),
        count: button.hasAttribute('data-count') ? numericInput(row.querySelector('input')) : Number(button.dataset.owned), overCap: $('#trainer-overcap').checked });
};

// ---------- 标签页 ----------
$$('.tab').forEach(tab => {
    tab.onclick = () => {
        $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
        $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab.dataset.panel));
        if (tab.dataset.panel === 'trainer') loadTrainer();
    };
});

// ---------- 状态轮询 ----------

/**
 * 渲染「当前连接」这一格 —— 让用户一眼看出面板连的是沙盒还是原版。
 *
 * 背景：沙盒和原版默认共用同一个调试端口，面板光看"已连接"分不出对面是谁。
 * 用户以为在沙盒里操作、实际改的是原版存档，是这套工具最危险的误用方式
 * （见 复查与隐患.md 坑 5）。这一格是最后一道兜底。
 *
 * 判断由服务端做（它有 gameDir 和 sandboxDir 两个路径可以比对），
 * 前端只负责显示，免得两边各写一套判断逻辑。
 */
function renderGameSrc(s) {
    const wrap = $('#st-src-wrap'), el = $('#st-src');
    if (!wrap || !el) return;

    const gs = s.gameSelf;
    let cls = 'stat game-src';
    let text = '—';

    if (!s.gameRunning) {
        text = '未启动游戏';
    } else if (!gs || !gs.dir) {
        // 连上了却读不到目录：可能地址形态和预期不一致。不硬猜，如实说读不到。
        text = '读不到游戏目录';
        cls += ' other';
    } else if (gs.kind === 'sandbox') {
        text = `${gs.dir}（沙盒）`;
        cls += ' sandbox';
    } else if (gs.kind === 'original') {
        text = `${gs.dir}  ⚠️ 这是原版！任何操作都在动正式存档`;
        cls += ' original';
    } else {
        text = `${gs.dir}（不在原版 / 沙盒路径上）`;
        cls += ' other';
    }

    wrap.className = cls;
    el.textContent = text;
}

async function refreshStatus() {
    if (STATUS_BUSY) return;
    STATUS_BUSY = true;
    try {
        const s = await api('/status');
        $('#connDot').className = 'dot ' + (s.connected ? 'on' : 'off');
        $('#connText').textContent = s.connected ? (s.gameSelf?.inMap ? `已连接游戏（端口 ${s.cdpPort}）` : '已连接，请在游戏里读档进入地图') : (s.gameRunning ? '调试端口可达，但连接未建立' : '未检测到游戏 — 请先启动游戏');
        renderGameSrc(s);
        applyStoryState(s.storyText || { state: 'disconnected', loaded: false, connection: null });
        const nextContext = s.connected && s.gameSelf?.inMap ? s.context : null;
        CURRENT_GAME = s.gameSelf;
        if (CURRENT_CONTEXT !== nextContext) {
            CURRENT_CONTEXT = nextContext;
            EVENTS_CONTEXT = LOST_CONTEXT = null;
            invalidateTrainer(nextContext ? '正在读取角色与背包…' : '请先连接游戏并进入地图');
            EVENTS = []; LOST = []; VISIBLE = [];
            renderEvents(); renderLost();
            if (TRIGGERS.length) loadTriggers();
        }
        const where = $('#photo-target');
        if (where) where.textContent = s.gameSelf?.saveDir || '未连接游戏，不能保存';

        if (s.connected && s.gameSelf?.inMap) {
            if ($('#panel-trainer').classList.contains('active')) loadTrainer();
            try {
                const snap = await api('/snapshot');
                $('#st-map').textContent = `${snap.mapId} ${snap.mapName}`.trim();
                $('#st-pos').textContent = `(${snap.x}, ${snap.y})`;
                $('#st-hp').textContent = snap.hp ?? '—';
                $('#st-sw').textContent = snap.switchesOn ?? '—';
                $('#st-grav').textContent = snap.gravitySuspended ? '已关' : '正常';
                $('#st-inv').textContent = snap.invincible ? '已开' : '关';

                // 换地图了 → 重新拉一次跳转点，好把新地图的"已抹除"状态标出来
                if (LAST_MAP !== null && LAST_MAP !== snap.mapId) loadTriggers();
                LAST_MAP = snap.mapId;
                for (const [key, id] of [['message','q-msg'],['artwork','q-art'],['hud','q-hud']]) {
                    $('#' + id).classList.toggle('on', !snap.uiHidden?.[key]);
                }
                $('#photo-state').textContent = snap.stagedActors ? `摆拍角色 ${snap.stagedActors} 个：存档照常；不推荐此时保存，读档后摆拍状态可能无法完整恢复` : '';
                // 顶部常驻开关：高亮 = 这个开关是"开着/显示着"的
                $('#q-gravity').classList.toggle('on', !snap.gravitySuspended);  // 高亮=重力正常
                $('#q-invincible').classList.toggle('on', !!snap.invincible);
                $('#q-noclip').classList.toggle('on', !!snap.noclip);
                if (snap.lilyVisible !== null && snap.lilyVisible !== undefined) {
                    $('#q-lily').classList.toggle('on', !!snap.lilyVisible);
                }

                // 传送面板右上角显示当前是"悬浮"还是"站立"
                const floating = snap.gravitySuspended || snap.noclip;
                $('#tp-state').textContent = floating ? '悬浮中' : '站立';
            } catch (e) {
                $('#st-map').textContent = '读取失败';
            }
        } else {
            $('#photo-state').textContent = '';
            ['st-map', 'st-pos', 'st-hp', 'st-sw', 'st-grav', 'st-inv'].forEach(id => $('#' + id).textContent = '—');
            $('#tp-state').textContent = '—';
        }
    } catch (e) {
        $('#connDot').className = 'dot off';
        $('#connText').textContent = '无法连接本地服务';
        applyStoryState({ state: 'disconnected', loaded: false, connection: null });
        CURRENT_CONTEXT = null; CURRENT_GAME = null; EVENTS_CONTEXT = LOST_CONTEXT = null;
        invalidateTrainer('连接已断开，请重连后刷新');
        renderGameSrc({gameRunning:false});
        $('#photo-target').textContent = '未连接游戏，不能保存';
        $('#photo-state').textContent = '';
        ['st-map','st-pos','st-hp','st-sw','st-grav','st-inv'].forEach(id => $('#' + id).textContent = '—');
        EVENTS = []; LOST = []; VISIBLE = []; renderEvents(); renderLost();
    } finally { STATUS_BUSY = false; }
}

// ---------- 传送 ----------
// 传送默认走"悬浮安全模式"（后端 teleport 里 float 默认为 true），
// 目的是绕开游戏的坠落复位机制，详见 ops.js 里 teleport 的注释。
$('#tp-go').onclick = async () => {
    const x = Number($('#tp-x').value), y = Number($('#tp-y').value);
    try {
        const r = await api('/teleport', { x, y });
        if (r.busy) {
            // 演出中的角色位置由事件系统接管，会被立刻覆盖 —— 说清楚，别让人以为工具坏了
            toast(`传送到 (${r.x}, ${r.y})，但游戏正在播放剧情，位置可能被演出覆盖。等剧情结束再传。`, 'err');
        } else if (r.float) {
            toast(`已传送到 (${r.x}, ${r.y})，悬浮中。想走动请点「落地」。`, 'ok');
        } else {
            toast(`已传送到 (${r.x}, ${r.y})`, 'ok');
        }
        refreshStatus();
    } catch (e) { toast(e.message, 'err'); }
};

$('#tp-here').onclick = async () => {
    try {
        const s = await api('/snapshot');
        $('#tp-x').value = s.x; $('#tp-y').value = s.y;
        toast(`已填入当前坐标 (${s.x}, ${s.y})`);
    } catch (e) { toast(e.message, 'err'); }
};

// 落地：后端会先探测脚下是不是坑，是坑就拒绝执行
$('#tp-land').onclick = async () => {
    const btn = $('#tp-land');
    btn.disabled = true;
    try {
        const r = await api('/land', {});
        toast(r.warning || `已落地（下坠 ${r.dropDistance} 像素）`, r.warning ? 'err' : 'ok');
        refreshStatus();
    } catch (e) {
        toast(e.message, 'err');
    }
    btn.disabled = false;
};

$$('[data-nudge]').forEach(b => {
    b.onclick = () => {
        const [dx, dy] = b.dataset.nudge.split(',').map(Number);
        $('#tp-x').value = Number($('#tp-x').value || 0) + dx;
        $('#tp-y').value = Number($('#tp-y').value || 0) + dy;
        $('#tp-go').click();
    };
});

// ---------- 本图事件 ----------
let EVENTS = [];

/**
 * 立绘名 → 人话。
 *
 * 事件的立绘名（img/characters/ 下的图名）本身有描述性，实测常见的有
 * ;cat_coin_copper(铜币) / ;moving_platform(移动平台) / ;minecar_wheel(矿车轮) 等。
 * 这里只翻译**能确定的**，不确定的一律原样显示英文名 ——
 * 猜一个错的译名比显示英文原名更糟。
 */
const SPRITE_NAMES = [
    [/^cat_coin_copper/, '铜币'],
    [/^cat_coin_silver/, '银币'],
    [/^cat_coin_gold/, '金币'],
    [/^cat_coin_diamond/, '钻石币'],
    [/^moving_platform/, '移动平台'],
    [/^minecar_wheel/, '矿车轮'],
    [/^minecar/, '矿车'],
    [/^icon_item_/, '道具图标'],
    [/^tower_box/, '宝箱'],
    [/^difficulty_switch/, '难度开关'],
    [/^iron_string/, '铁索'],
    [/^frame$/, '边框装饰'],
    [/_fake\d*$/, '装饰地形'],
];

function spriteLabel(sprite) {
    if (!sprite) return '';
    for (const [re, name] of SPRITE_NAMES) if (re.test(sprite)) return name;
    return '';   // 不认识就返回空，调用方会退回显示英文原名
}

async function loadEvents() {
    const btn = $('#ev-load');
    btn.disabled = true;
    try {
        const r = await api('/events');
        if (r.context !== CURRENT_CONTEXT) throw new Error('地图已变化，请刷新本图事件');
        EVENTS_CONTEXT = r.context;
        EVENTS = r.events || [];
        const withStory = EVENTS.filter(e => e.hasStory).length;
        renderEvents();
        toast(`本图 ${EVENTS.length} 个事件，其中 ${withStory} 个带剧情`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
}

function renderEvents() {
    const q = $('#ev-filter').value.trim().toLowerCase();
    const showAll = $('#ev-all').checked;

    let list = showAll ? EVENTS : EVENTS.filter(e => e.hasStory);
    if (q) {
        list = list.filter(e => {
            const hay = [e.name, e.sprite, e.trigger,
                         ...(e.lines || []).map(l => l.searchText || (l.first + ' ' + l.speaker))]
                        .join(' ').toLowerCase();
            return hay.includes(q) || String(e.id).includes(q);
        });
    }
    // 带剧情的排前面
    list = [...list].sort((a, b) => (b.hasStory ? 1 : 0) - (a.hasStory ? 1 : 0));

    const box = $('#ev-list');
    if (!list.length) {
        box.innerHTML = `<div class="empty">${showAll ? '没有匹配的事件' : '本图没有带剧情的事件（可勾选「显示全部事件」）'}</div>`;
        return;
    }

    box.innerHTML = list.map(e => {
        const first = (q && (e.lines || []).find(l => (l.searchText || '').toLowerCase().includes(q))) || (e.lines && e.lines[0]) || null;
        const match = q && (first?.lines || []).find(l => (l.text + ' ' + l.speaker).toLowerCase().includes(q));
        // 有剧情就用台词当标题，否则退回"立绘译名 → 英文原名 → 事件触发方式"
        const headline = first
            ? `「${esc(match?.text || first.first)}」${(match?.speaker || first.speaker) ? ' — ' + esc(match?.speaker || first.speaker) : ''}`
            : (spriteLabel(e.sprite) || e.sprite || `${e.trigger}的事件`);
        const raw = (first ? '' : (e.sprite ? ` · ${esc(e.sprite)}` : ''));
        const more = (e.lines && e.lines.length > 1) ? ` · 共 ${e.lines.length} 段剧情` : '';

        return `
        <div class="item">
            <span class="num">#${e.id}</span>
            <span class="grow">
                <span class="name">${headline}</span>
                <span class="meta">(${e.x}, ${e.y}) · ${esc(e.trigger)}${more}${raw}</span>
            </span>
            ${e.hasStory ? '<span class="tag common">剧情</span>' : ''}
            <button data-go-x="${e.x}" data-go-y="${e.y}">传送</button>
        </div>`;
    }).join('');

    box.querySelectorAll('button[data-go-x]').forEach(b => {
        b.onclick = async () => {
            try {
                const r = await api('/teleport', { x: Number(b.dataset.goX), y: Number(b.dataset.goY), context: EVENTS_CONTEXT });
                toast(r.busy
                    ? `已传送到 (${r.x}, ${r.y})，但游戏正在播放剧情，位置可能被覆盖。`
                    : `已传送到 (${r.x}, ${r.y})，悬浮中。`, r.busy ? 'err' : 'ok');
                refreshStatus();
            } catch (e) { toast(e.message, 'err'); }
        };
    });
}
$('#ev-load').onclick = loadEvents;
$('#ev-filter').oninput = renderEvents;
$('#ev-all').onchange = renderEvents;

// ---------- 场景还原（摆拍）----------
// 静态摆拍由 photo-state 管理。撤销恢复原状态；摆拍期间仅提示保存风险。
let LOST = [];          // 所有"有可能拉出来"的事件
let VISIBLE = [];       // 现在已经看得见的

async function scanLost() {
    const btn = $('#lost-scan');
    btn.disabled = true;
    try {
        const r = await api('/events/lost');
        if (r.context !== CURRENT_CONTEXT) throw new Error('地图已变化，请重新扫描');
        LOST_CONTEXT = r.context;
        LOST = r.lost || [];
        VISIBLE = r.visible || [];
        renderLost();
        const erased = LOST.filter(e => e.erased).length;
        toast(`本图现在可见 ${VISIBLE.length} 个角色；另有 ${LOST.length} 个可以拉出来`
            + (erased ? `（其中 ${erased} 个是被抹除的）` : ''), 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
}

function renderLost() {
    const box = $('#lost-list');
    if (!LOST.length && !VISIBLE.length) {
        box.innerHTML = '<div class="empty">本图没有可显示的角色（或还没扫描）</div>';
        return;
    }

    let html = '';

    // 已经看得见的：告诉你"这些本来就在场"，免得以为多了
    if (VISIBLE.length) {
        html += `<div class="item cat-head">已在场（${VISIBLE.length} 个）—— 这些本来就有，不是多出来的</div>`;
        html += VISIBLE.map(v => `
            <div class="item">
                <span class="num">#${v.id}</span>
                <span class="grow">
                    <span class="name">${esc(String(v.sprite).replace(/^;/, ''))}</span>
                    <span class="meta">(${v.x}, ${v.y})</span>
                </span>
                <span class="tag ok">在场</span>
            </div>`).join('');
    }

    // 可以拉出来的：分成"被抹除"（该在不在）和"游戏隐藏"（可能是有意的）
    const erased = LOST.filter(e => e.erased);
    const hidden = LOST.filter(e => !e.erased);

    if (erased.length) {
        html += `<div class="item cat-head">被游戏抹除（${erased.length} 个）—— 曾被事件脚本抹除；是否符合目标剧情需自行核对</div>`;
        html += erased.map(e => lostRow(e)).join('');
    }
    if (hidden.length) {
        html += `<div class="item cat-head warn-head">游戏有意隐藏（${hidden.length} 个）—— 可能是剧情推进后本来就该退场，拉出来未必符合原作</div>`;
        html += hidden.map(e => lostRow(e)).join('');
    }

    box.innerHTML = html;
    box.querySelectorAll('button[data-lost]').forEach(b => {
        b.onclick = () => forcePageOf(LOST[Number(b.dataset.lost)]);
    });

    const hint = $('#lost-hint');
    if (hint) {
        hint.textContent = LOST.length
            ? `共 ${LOST.length} 个可拉出（抹除 ${erased.length} / 游戏隐藏 ${hidden.length}）`
            : '本图没有被隐藏的角色';
    }
}

function lostRow(e) {
    const i = LOST.indexOf(e);
    return `
        <div class="item">
            <span class="num">#${e.id}</span>
            <span class="grow">
                <span class="name">${esc(String(e.suggestSprite).replace(/^;/, ''))}</span>
                <span class="meta">(${e.x}, ${e.y}) · 切到第 ${e.suggestPage + 1} 页</span>
            </span>
            ${e.erased ? '<span class="tag danger">已抹除</span>' : '<span class="tag">游戏隐藏</span>'}
            <button data-lost="${i}">拉出来</button>
        </div>`;
}

async function forcePageOf(e) {
    try {
        const r = await api('/events/force-page', { eventId: e.id, page: e.suggestPage, context: LOST_CONTEXT });
        if (!r.ok) throw new Error(r.error || '切页失败');
        if (!r.visible) {
            toast(`事件 #${e.id} 切到第 ${r.page + 1} 页，但这一页没有立绘`, 'err');
        } else {
            toast(`已拉出 ${r.sprite.replace(/^;/, '')}（第 ${r.page + 1} 页）。可截图，完成后点“撤销场景还原”。`, 'ok');
        }
    } catch (err) { toast(err.message, 'err'); }
}

$('#lost-scan').onclick = scanLost;

// 取消所有"钉住"的页号：强切页现在是靠覆盖 findProperPageIndex 实现的，
// 会一直生效（这是为了扛住游戏的重算），想恢复原状就点这个。
$('#lost-unpin').onclick = async () => {
    try {
        const r = await api('/events/unpin', {});
        toast(r.unpinned ? `已撤销 ${r.unpinned} 个角色的摆拍状态` : '本图没有被人为固定的角色');
        scanLost();
    } catch (e) { toast(e.message, 'err'); }
};

// 默认只恢复"被抹除"的 —— 那些是明确的"该在不在"。
// 连"游戏有意隐藏"的一起拉，会凭空多出人物，所以单独一个按钮 + 明确警告。
$('#lost-restore-all').onclick = () => restoreAll(false);
$('#lost-restore-hidden').onclick = () => restoreAll(true);

async function restoreAll(includeHidden) {
    if (includeHidden && !confirm(
        '这会把「游戏有意隐藏」的角色也一起拉出来。\n\n' +
        '那些角色可能是剧情推进后本来就该退场的，拉出来会让画面多出不该在场的人物，\n' +
        '和原作不符。\n\n确定继续吗？')) return;

    const btn = includeHidden ? $('#lost-restore-hidden') : $('#lost-restore-all');
    btn.disabled = true;
    try {
        const r = await api('/events/restore-cast', { includeHidden });
        if (!r.restored) {
            toast(r.skippedCount
                ? `没有"被抹除"的角色可恢复（另有 ${r.skippedCount} 个是游戏有意隐藏的，要用旁边那个按钮）`
                : '没有可拉出来的角色（先点「扫描」确认本图有没有）');
        } else if (r.duplicates && r.duplicates.length) {
            // 同一角色在数据里有好几份事件，全拉出来会变成好几个一样的人
            const d = r.duplicates.map(x => `${x.sprite.replace(/^;/, '')} ×${x.count}`).join('、');
            toast(`拉出了 ${r.restored} 个，但其中有重复：${d}。`
                + `同一个角色在数据里有好几份事件，全拉出来会变成好几个一模一样的人。`
                + `建议只保留需要的那一个（先「全部还原」再单独点某个「拉出来」）。`, 'err');
        } else {
            toast(`拉出了 ${r.restored} 个角色`
                + (r.erasedCount ? `（其中 ${r.erasedCount} 个是被抹除的，静态摆拍角色）` : '')
                + (r.skippedCount ? `。另有 ${r.skippedCount} 个是游戏有意隐藏的，没动` : '')
                + '。完成后点“撤销场景还原”。', 'ok');
        }
        scanLost();
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
}

// ---------- 存拍照专用档 ----------
$('#photo-save').onclick = async () => {
    const slot = Number($('#photo-slot').value);
    const target = CURRENT_GAME?.kind;
    if (!CURRENT_CONTEXT || !['sandbox','original'].includes(target)) return toast('无法确认当前游戏和存档目录', 'err');
    const where = (target === 'sandbox' ? '沙盒' : '原版') + '：' + CURRENT_GAME.saveDir;
    if (!confirm(`确定要把当前场景存进【${where}】的存档槽 ${slot} 吗？\n\n这会覆盖该槽位原有的进度。\n若正在摆拍，不推荐此时保存：读档后角色、UI 或对白可能无法完整恢复。仍可确定继续保存。\n（工具会先自动备份整个存档目录）`)) return;
    try {
        const r = await api('/save-photo', { slot, target });
        if (!r.ok) throw new Error(r.error || '存档失败');
        toast(`已存到槽 ${r.slot}（地图 ${r.mapId} 坐标 ${r.x},${r.y}）。存档前状态已备份为 ${r.safetyBackup}`, 'ok');
        loadBackups();
    } catch (e) { toast(e.message, 'err'); }
};

// ---------- 对话跳转点 ----------
async function loadTriggers() {
    const request = ++TRIGGER_REQUEST;
    try {
        const r = await api('/triggers');
        if (request !== TRIGGER_REQUEST) return;
        STORY_TEXT_STATE = r.storyText; renderStoryTextHint();
        TRIGGERS = r.triggers || [];
        $('#story-count').textContent = `${TRIGGERS.length} 条（其中 ${TRIGGERS.filter(t => t.actionable).length} 条可一键跳转）`;
        renderTriggers();
    } catch (e) {
        if (request === TRIGGER_REQUEST) $('#story-list').innerHTML = `<div class="empty">载入失败：${esc(e.message)}</div>`;
    }
}

function renderTriggers() {
    const q = $('#story-filter').value.trim().toLowerCase();
    const onlyActionable = $('#story-only-actionable').checked;
    const onlySwitch = $('#story-need-switch').checked;

    const list = TRIGGERS.filter(t => {
        if (onlyActionable && !t.actionable) return false;
        if (onlySwitch && !t.needSwitchNames.length) return false;
        if (!q) return true;
        const hay = [t.storyId, t.mapId, t.mapArea, t.searchText, t.line, t.speaker, t.eventName,
                     t.triggerType, t.x, t.y, t.condition, ...t.needSwitchNames].join(' ').toLowerCase();
        return hay.includes(q);
    });

    const box = $('#story-list');
    if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的跳转点</div>'; return; }

    box.innerHTML = list.map((t, i) => {
        // 台词是主要标识 —— "地图170" 谁也看不懂，"「好烦啊！」— 喵露露" 一眼就认出来
        const match = q && (t.lines || []).find(l => (l.text + ' ' + l.speaker).toLowerCase().includes(q));
        const preview = match?.text || t.line, speaker = match?.speaker || t.speaker;
        const headline = preview
            ? `「${esc(preview)}」${speaker ? ' — ' + esc(speaker) : ''}`
            : `<span class="meta">${esc(t.actionable ? `地图${t.mapId} (${t.x}, ${t.y})` : `故事 #${t.storyId}`)} · ${esc(t.triggerType)}</span>`;
        const where = [
            t.mapArea ? esc(t.mapArea) : '',
            t.actionable ? `地图${t.mapId} (${t.x}, ${t.y})` : '无坐标',
            t.triggerType || '',
            t.positionNote ? esc(t.positionNote) : '',
            t.lineCount > 1 ? `共 ${t.lineCount} 句` : '',
        ].filter(Boolean).join(' · ');

        return `
        <div class="item">
            <span class="num">#${t.storyId}</span>
            <span class="grow">
                <span class="name">${headline}</span>
                <span class="meta">${where}</span>
            </span>
            ${t.needSwitchNames.length ? `<span class="tag common">需开关 ${t.needSwitchNames.length}</span>` : ''}
            ${t.erased === true ? '<span class="tag danger" title="这个触发事件被游戏自己抹除了，走过去也不会触发，开关怎么补都没用 —— 请用「运行过场」">已抹除</span>' : ''}
            ${t.actionable ? `
                <button class="primary" data-scene="${i}">运行过场</button>
                <button data-play="${i}">只播台词</button>
                <button data-goto="${i}" ${t.erased === true ? 'title="这个触发事件已被游戏抹除，「前往」大概率没反应，建议用「运行过场」"' : ''}>前往</button>` : ''}
        </div>`;
    }).join('');

    // --- 运行过场：执行含这段对话的整个事件页 —— NPC 站位、演出、对白全按原样走 ---
    box.querySelectorAll('button[data-scene]').forEach(b => {
        b.onclick = async () => {
            const t = list[Number(b.dataset.scene)];
            b.disabled = true;
            try {
                const r = await api('/story/start', { mode: 'scene', x: t.x, y: t.y, mapId: t.mapId, storyId: t.storyId, eventId: Number(t.eventId) || null, pageIndex: t.pageIndex });
                if (!r.ok) throw new Error(r.error || '运行失败');

                const sb = r.speakerBody || {};
                const bodyNote = sb.forced
                    ? `说话者已就位（${String(sb.sprite || '').replace(/^;/, '')}）`
                    : (sb.reason ? `说话者没身体：${sb.reason}` : '');

                if (!r.started) {
                    toast('过场已开始，但还没出现对话窗口。前面可能有一段移动/演出，稍等一下。', 'ok');
                } else if (r.matched === false) {
                    toast(`播出的是故事 ${r.playedStoryId}，不是你要的 #${t.storyId}。请把这条反馈给开发者。`, 'err');
                } else if (r.insideBranch) {
                    toast(`已播 #${t.storyId}。这段对话在【条件分支】里，所以直接从该分支开始播，`
                        + `跳过了前面 ${r.startAt} 条摆位指令。${bodyNote}`, 'ok');
                } else {
                    toast(`过场执行中（事件 ${r.eventName}，共 ${r.commands} 条指令）。${bodyNote}。可以一路截图。`, 'ok');
                }
                if (r.landingWarning) toast(r.landingWarning, 'err');
                else if (r.positionNote) toast(r.positionNote, 'ok');
                refreshStatus();
            } catch (e) { toast(e.message, 'err'); }
            b.disabled = false;
        };
    });

    // --- 只播台词：从指令层直接调用 call_story，跳过节目前的演出 ---
    // 适合只想快速看一眼这段对话；缺点是场景里可能没有对应的 NPC（见开发文档第 6 节）
    box.querySelectorAll('button[data-play]').forEach(b => {
        b.onclick = async () => {
            const t = list[Number(b.dataset.play)];
            b.disabled = true;
            try {
                const r = await api('/story/start', { mode: 'play', x: t.x, y: t.y, mapId: t.mapId, storyId: t.storyId, eventId: Number(t.eventId) || null, pageIndex: t.pageIndex });
                if (!r.ok) throw new Error(r.error || '播放失败');
                if (!r.started) {
                    toast('剧情已下发，但没等到对话窗口出现。可能这段剧情需要特定场景。', 'err');
                } else if (r.matched === false) {
                    toast(`播放的可能不是这段——画面显示「${r.firstText.slice(0, 16)}」，期望「${(r.expected || '').slice(0, 16)}」。先点「关闭对话窗口」再重试。`, 'err');
                } else {
                    toast(`正在播放 #${t.storyId}（共 ${r.lines} 句）${r.speaker ? '，' + r.speaker + '：' : '：'}${r.firstText.slice(0, 20)}`, 'ok');
                }
                refreshStatus();
            } catch (e) { toast(e.message, 'err'); }
            b.disabled = false;
        };
    });

    // --- 前往：打开开关 + 传送，之后自己走过去按确定键 ---
    box.querySelectorAll('button[data-goto]').forEach(b => {
        b.onclick = async () => {
            const t = list[Number(b.dataset.goto)];
            b.disabled = true;
            try {
                const pairs = [];
                const missing = [];
                for (const name of t.needSwitchNames) {
                    const id = SWITCH_BY_NAME.get(name);
                    if (id === undefined) missing.push(name);
                    else pairs.push([id, true]);
                }
                const tp = await api('/story/goto', { pairs, x: t.x, y: t.y, mapId: t.mapId, storyId: t.storyId, eventId: Number(t.eventId) || null, pageIndex: t.pageIndex });
                if (!tp.ok) throw new Error(tp.error || '传送失败');

                const where = tp.changedMap ? `已切换到地图 ${tp.mapId}` : `已传送到 (${tp.x}, ${tp.y})`;
                if (missing.length) {
                    toast(`${where}，但有 ${missing.length} 个开关没找到：${missing.join('、')}`, 'err');
                } else {
                    toast(`${where}，打开了 ${pairs.length} 个普通开关。` + ((t.needVarNames.length || /独立开关/.test(t.condition)) ? '仍需手动核对条件：' + t.condition : '点「落地」站到地上，再尝试触发。'), (t.needVarNames.length || /独立开关/.test(t.condition)) ? 'err' : 'ok');
                }
                refreshStatus();
            } catch (e) { toast(e.message, 'err'); }
            b.disabled = false;
        };
    });
}

$('#story-filter').oninput = renderTriggers;
$('#story-only-actionable').onchange = renderTriggers;
$('#story-need-switch').onchange = renderTriggers;

$('#story-load-text').onclick = async () => {
    const button = $('#story-load-text'); button.disabled = true;
    try {
        const state = await api('/story-text', { refresh: true });
        applyStoryState(state);
        await loadTriggers();
        toast(state.loaded ? `已读取 ${state.count} 条剧情，可搜索任意一句台词` : (state.error || '游戏未连接或故事表尚未就绪'), state.loaded ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
    finally { button.disabled = false; }
};

$('#story-close-msg').onclick = async () => {
    try {
        await api('/story/close', {});
        toast('已关闭对话窗口');
    } catch (e) { toast(e.message, 'err'); }
};

// ---------- 开关 ----------
let SWITCH_VALUES = {};
async function loadSwitches() {
    try {
        const r = await api('/switches');
        SWITCHES = r.switches || [];
        SWITCH_VALUES = r.values || {};
        SWITCH_BY_NAME = new Map(SWITCHES.map(s => [s.name, s.id]));
        renderSwitches();
        if (!r.connected) toast('开关当前值读取失败（游戏未连接），仅显示名称', 'err');
    } catch (e) {
        $('#sw-list').innerHTML = `<div class="empty">载入失败：${esc(e.message)}</div>`;
    }
}

function renderSwitches() {
    const q = $('#sw-filter').value.trim().toLowerCase();
    let list = SWITCHES;
    if (!SHOW_ALL_SWITCHES) list = list.filter(s => s.common);
    if (q) list = list.filter(s => s.name.toLowerCase().includes(q) || String(s.id) === q);
    list = list.slice(0, 500);

    $('#sw-mode').textContent = SHOW_ALL_SWITCHES
        ? `当前：全部开关（${SWITCHES.length} 个）`
        : `当前：常用开关（${SWITCHES.filter(s => s.common).length} 个）`;
    $('#sw-toggle-all').textContent = SHOW_ALL_SWITCHES
        ? '只看常用开关'
        : `展开全部 ${SWITCHES.length} 个`;

    const box = $('#sw-list');
    if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的开关</div>'; return; }

    box.innerHTML = list.map(s => {
        const on = SWITCH_VALUES[s.id] === 1;
        const known = s.id in SWITCH_VALUES;
        return `
        <div class="item">
            <span class="num">#${s.id}</span>
            <span class="grow">
                <span class="name">${esc(s.name)}</span>
                ${s.common ? '<span class="tag common">常用</span>' : ''}
            </span>
            <span class="${on ? 'switch-on' : 'switch-off'}">${known ? (on ? 'ON' : 'OFF') : '—'}</span>
            <button data-sw="${s.id}" data-val="1">开</button>
            <button data-sw="${s.id}" data-val="0">关</button>
        </div>`;
    }).join('');

    box.querySelectorAll('button[data-sw]').forEach(b => {
        b.onclick = async () => {
            const id = Number(b.dataset.sw), val = b.dataset.val === '1';
            try {
                await api('/switch', { id, value: val });
                SWITCH_VALUES[id] = val ? 1 : 0;
                renderSwitches();
                refreshStatus();
            } catch (e) { toast(e.message, 'err'); }
        };
    });
}

$('#sw-filter').oninput = renderSwitches;
$('#sw-reload').onclick = loadSwitches;
$('#sw-toggle-all').onclick = () => { SHOW_ALL_SWITCHES = !SHOW_ALL_SWITCHES; renderSwitches(); };

// ---------- 顶部常驻开关 ----------
// 高亮 = 这个开关是"开着/显示着"的。语义统一，见 index.html 里的 title 提示。
const chipOn = (id) => $('#' + id).classList.contains('on');

async function flipChip(id, fn) {
    const el = $('#' + id);
    el.disabled = true;
    try {
        await fn(!chipOn(id));
        refreshStatus();
    } catch (e) {
        toast(e.message, 'err');
        refreshStatus();
    }
    el.disabled = false;
}

// 重力：高亮 = 正常。点一下切换成"关掉重力"（角色悬空）
$('#q-gravity').onclick = () => flipChip('q-gravity', on => api('/gravity', { on: !on }));
// 无敌 / 穿墙：高亮 = 开启
$('#q-invincible').onclick = () => flipChip('q-invincible', on => api('/invincible', { on }));
$('#q-noclip').onclick = () => flipChip('q-noclip', on => api('/noclip', { on }));
// 莉莉娅：高亮 = 显示中
// ⚠️ flipChip 传进来的是**按钮的新状态**（true = 希望莉莉娅显示），直接当 show 用。
//    之前写成 show: !on，等于每次都"再显示一遍"，点了毫无反应（用户报过）。
$('#q-lily').onclick = () => flipChip('q-lily', async wantVisible => {
    await api('/lily', { show: wantVisible });
    toast(wantVisible ? '莉莉娅已显示' : '莉莉娅已隐藏（有些剧情里她本来就在场，注意别藏错）', 'ok');
});

// 拍照辅助：高亮 = 显示中；点一下藏起来
// 注意这是"藏起来"不是"关掉"，随时能显示回来。
// 要真的关掉对话请用「对话剧情」页的「关闭对话窗口」。
//
// ⚠️ 注意 `/api/ui-hidden` 的语义是**反向**的：字段传 true 表示"藏起来"。
//    而 flipChip 传进来的是"按钮的新状态"（true = 希望它显示着）。
//    所以要取反：setUi({ message: !wantVisible })。
//    （之前直接传 wantVisible，等于每次都在"显示"，点了没反应。
//      莉莉娅那个按钮也是同一个毛病，一起修了。）
$('#q-msg').onclick = () => flipChip('q-msg', async wantVisible => {
    await setUi({ message: !wantVisible });
    toast(wantVisible ? '对话框已显示' : '对话框已隐藏（只是藏起来，随时能显示回来）');
});
$('#q-art').onclick = () => flipChip('q-art', wantVisible => setUi({ artwork: !wantVisible }));
$('#q-hud').onclick = () => flipChip('q-hud', wantVisible => setUi({ hud: !wantVisible }));

async function setUi(state) {
    const r = await api('/ui-hidden', state);
    if (!r.ok) return;
    // 用返回值回写按钮状态，别靠本地猜测
    if (r.state.message !== undefined) $('#q-msg').classList.toggle('on', !r.state.message);
    if (r.state.artwork !== undefined) $('#q-art').classList.toggle('on', !r.state.artwork);
    if (r.state.hud !== undefined) $('#q-hud').classList.toggle('on', !r.state.hud);
}

$('#q-restore').onclick = async () => {
    try {
        await api('/restore', {});
        toast('已还原重力、碰撞、无敌，撤销摆拍并解除数值锁定', 'ok');
        loadTrainer(true);
        refreshStatus();
    } catch (e) { toast(e.message, 'err'); }
};

// ---------- 存档与沙盒 ----------
async function loadBackups() {
    try {
        const r = await api('/backups');
        const box = $('#bk-list');
        if (!r.backups.length) { box.innerHTML = '<div class="empty">还没有备份</div>'; return; }
        box.innerHTML = r.backups.map(b => `
            <div class="item">
                <span class="grow">
                    <span class="name">${esc(b.name)}</span>
                    <span class="meta"> ${b.files} 个文件 · 来源：${esc(b.sourceDir || '旧备份，来源未知')} · ${new Date(b.mtime).toLocaleString('zh-CN')}</span>
                </span>
                <button class="danger" data-restore="${esc(b.name)}">还原到此备份</button>
            </div>`).join('');
        box.querySelectorAll('button[data-restore]').forEach(btn => {
            btn.onclick = async () => {
                const name = btn.dataset.restore;
                const target = $('#bk-target').value;
                if (!target) return toast('请先明确选择还原目标', 'err');
                let cfg; try { cfg = await api('/status'); } catch (e) { return toast(e.message, 'err'); }
                const dir = target === 'sandbox' ? cfg.sandboxDir : cfg.gameDir;
                if (!confirm(`将「${name}」还原到【${target === 'sandbox' ? '沙盒' : '原版'}】\n${dir}\n\n请先退出游戏。目标现有存档会先备份；备份中没有的槽位也会被移出当前存档集合。`)) return;
                try {
                    const r = await api('/restore-backup', { name, confirm: true, target });
                    toast(`已还原 ${r.restored} 个文件（还原前的状态已存为 ${r.safetyBackup}）`, 'ok');
                    loadBackups();
                } catch (e) { toast(e.message, 'err'); }
            };
        });
    } catch (e) {
        $('#bk-list').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
    }
}

async function doBackup(sandbox) {
    try {
        const r = await api('/backup', { target: sandbox ? 'sandbox' : 'original' });
        toast(`已备份 ${r.files} 个文件 → ${r.name}`, 'ok');
        loadBackups();
    } catch (e) { toast(e.message, 'err'); }
}
$('#bk-original').onclick = () => doBackup(false);
$('#bk-sandbox').onclick = () => doBackup(true);
$('#bk-reload').onclick = loadBackups;

async function refreshSandbox() {
    try {
        const s = await api('/status');
        const info = $('#sb-info');
        if (s.sandboxJob && s.sandboxJob.running) {
            info.innerHTML = `⏳ 正在拷贝到 <code>${esc(s.sandboxDir)}</code>…（请稍候，复制后会校验文件）`;
            setTimeout(refreshSandbox, 2500);
        } else if (s.sandboxJob && s.sandboxJob.error) {
            info.innerHTML = `❌ 拷贝失败：${esc(s.sandboxJob.error)}`;
        } else if (s.sandboxExists) {
            info.innerHTML = `✅ 沙盒已就绪：<code>${esc(s.sandboxDir)}</code><br>用 SDK 版 NW.js 启动它即可（调试端口 ${s.cdpPort}）。`;
        } else {
            info.innerHTML = `尚未创建。创建后会拷贝到 <code>${esc(s.sandboxDir)}</code>。`;
        }
    } catch (e) { /* 忽略 */ }
}

$('#sb-create').onclick = async () => {
    if (!confirm('将复制游戏和存档，排除工具及发布版目录，完成后校验副本。\n\n继续吗？')) return;
    try {
        await api('/sandbox', {});
        toast('已开始拷贝，请稍候…');
        refreshSandbox();
    } catch (e) { toast(e.message, 'err'); }
};
$('#sb-status').onclick = refreshSandbox;

// ---------- 设置 ----------
let CONFIG = {};

async function loadConfig() {
    try {
        const r = await api('/config');
        CONFIG = r.config;
        $('#set-cdpPort').value = r.config.cdpPort;
        $('#set-webPort').value = r.config.webPort;
        $('#set-sandboxDir').value = r.config.sandboxDir;
        $('#set-path').textContent = 'tool/config.json';
    } catch (e) { toast('读取配置失败：' + e.message, 'err'); }
}

$('#set-save').onclick = async () => {
    try {
        const r = await api('/config', {
            cdpPort: Number($('#set-cdpPort').value),
            webPort: Number($('#set-webPort').value),
            sandboxDir: $('#set-sandboxDir').value,
        });
        CONFIG = r.config;
        let msg = '设置已保存';
        if (r.cdpReconnected) msg += '（调试端口已切换）';
        if (r.webPortNeedsRestart) msg += '。控制面板端口要重启工具才生效';
        toast(msg, 'ok');
        refreshStatus();
        refreshSettingsInfo();
    } catch (e) { toast(e.message, 'err'); }
};

$('#set-reset').onclick = async () => {
    if (!confirm('把端口和路径恢复成默认值？')) return;
    try {
        // 用后端的 DEFAULTS 回填，避免前端写死一份会过期的默认值
        const r = await api('/config');
        await api('/config', {
            cdpPort: r.defaults.cdpPort,
            webPort: r.defaults.webPort,
            sandboxDir: r.defaults.sandboxDir,
        });
        await loadConfig();
        toast('已恢复默认值', 'ok');
        refreshStatus();
        refreshSettingsInfo();
    } catch (e) { toast(e.message, 'err'); }
};

async function refreshSettingsInfo() {
    try {
        const s = await api('/status');
        const rows = [
            ['游戏目录', s.gameDir],
            ['沙盒目录', s.sandboxDir + (s.sandboxExists ? '  ✓ 已就绪' : '  ✗ 未创建')],
            ['调试端口', s.cdpPort + (s.gameRunning ? '  ✓ 已检测到游戏' : '  ✗ 未检测到')],
            ['连接状态', s.connected ? '✓ 已连接游戏' : '✗ 未连接'],
            ['数据', `${s.stats.switches} 个开关 · ${s.stats.triggersUnique} 条触发点（可跳转 ${s.stats.triggersActionable}）`],
            ['台词索引', `${s.stats.storyLoaded} 条剧情 · ${s.stats.triggersWithLine} 条触发点有台词`],
        ];
        $('#set-info').innerHTML = rows.map(([k, v]) =>
            `<div class="item"><span class="grow"><span class="meta">${esc(k)}</span><br><span class="name">${esc(v)}</span></span></div>`
        ).join('');
    } catch (e) {
        $('#set-info').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
}

// ---------- 启动 ----------
(async function init() {
    await refreshStatus();
    await loadSwitches();     // 先拿开关名表，跳转点要用它把开关名换成编号
    await loadTriggers();
    await loadBackups();
    await loadConfig();
    refreshSandbox();
    refreshSettingsInfo();
    setInterval(refreshStatus, 3000);
})();
