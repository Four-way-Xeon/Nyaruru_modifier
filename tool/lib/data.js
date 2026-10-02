// 静态数据加载
//
// 数据来源全部是**之前分析阶段已产出的本地文件**（aitemp/out 和 aietmp/unpacked），
// 工具运行时只读它们，不碰游戏目录里的任何文件。
//
//   unpacked/data/System.json    → 360 个开关的中文名
//   unpacked/data/MapInfos.json  → 393 张地图
//   out/triggers.csv             → 897 条剧情触发点（其中 731 条有坐标）
//
// ⚠️ **台词不在这里。** 这是"C 方案"（见开发文档 12.5）的核心约定：
//    随包分发的只有**结构索引**（哪里有个触发点），
//    一个字创作内容都不带。台词在连上游戏后从 `$dataStory` 实时读，
//    只存在于内存，**绝不落盘**（读取逻辑在 lib/ops.js 的 readStoryIndex）。
//
//    历史：早期版本这里有个 loadStoryIndex()，启动时读 ../out/story.json
//    （1.9 MB，全部 870 条剧情的完整台词）。那是作者的原创剧本，
//    随包外传等于分发游戏内容，发布版必须去掉。

const fs = require('fs');
const path = require('path');

/** 极简 CSV 解析（RFC4180：支持引号包裹、字段内逗号、双引号转义） */
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    // 去掉 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n') {
            row.push(field); rows.push(row); row = []; field = '';
        } else if (c !== '\r') {
            field += c;
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 载入每张地图的 BGM 名，用来做**粗略的区域提示**。
 *
 * 游戏的地图在 MapInfos.json 里只有 "MAP170" 这种编号，没有地点名
 * （Map*.json 里的 displayName 和 meta 都是空的）。
 * 但 BGM 文件名有区分度：cave(24张) / black_forest(26张) / lake(23张)…
 * 所以拿它当"这片区域大概是什么"的线索，聊胜于无。
 */
const AREA_NAMES = {
    cave: '洞窟', black_forest: '黑森林', lake: '湖畔',
    town: '城镇', boss: 'Boss 战', title: '标题',
};

function loadMapAreas(dataDir) {
    const areas = new Map();
    let files;
    try { files = fs.readdirSync(dataDir); } catch { return areas; }

    for (const f of files) {
        const m = /^Map(\d+)\.json$/.exec(f);
        if (!m) continue;
        try {
            const d = readJson(path.join(dataDir, f));
            const bgm = (d.bgm && d.bgm.name) || '';
            if (bgm) areas.set(Number(m[1]), AREA_NAMES[bgm] || bgm);
        } catch { /* 个别地图文件损坏不影响整体 */ }
    }
    return areas;
}

/**
 * 载入全部静态数据。
 * @param {string} baseDir aitemp 目录
 */
function loadAll(baseDir) {
    const outDir = path.join(baseDir, 'out');
    const dataDir = path.join(baseDir, 'unpacked', 'data');

    // ---- 开关 ----
    const sys = readJson(path.join(dataDir, 'System.json'));
    const switches = [];
    const switchNameToId = new Map();
    for (let i = 1; i < sys.switches.length; i++) {
        const name = sys.switches[i];
        if (name === undefined || name === null) continue;
        switches.push({ id: i, name: String(name) });
        // 同名开关极少见，出现时保留首个
        if (!switchNameToId.has(String(name))) switchNameToId.set(String(name), i);
    }

    // ---- 变量 ----
    const variables = [];
    for (let i = 1; i < sys.variables.length; i++) {
        const name = sys.variables[i];
        if (name === undefined || name === null) continue;
        variables.push({ id: i, name: String(name) });
    }

    // ---- 地图 ----
    const mapInfos = readJson(path.join(dataDir, 'MapInfos.json'));
    const maps = mapInfos
        .filter(m => m && m.id)
        .map(m => ({ id: m.id, name: String(m.name || ''), parentId: m.parentId || 0 }));

    // ---- 区域名 ----
    // 台词**不在这里**：它由 server.js 在连上游戏后从 $dataStory 实时补进内存
    const mapAreas = loadMapAreas(dataDir);

    // ---- 剧情触发点 ----
    const csvPath = path.join(outDir, 'triggers.csv');
    const raw = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    const header = raw[0];
    const col = (row, key) => row[header.indexOf(key)] ?? '';

    const triggers = [];
    for (let i = 1; i < raw.length; i++) {
        const r = raw[i];
        if (!r || r.length < 2) continue;

        // 地图字段形如 "Map004.json MAP004"，从中取出数字 ID
        const mapField = col(r, '地图');
        const mapMatch = /Map0*(\d+)\.json/i.exec(mapField);
        const mapId = mapMatch ? Number(mapMatch[1]) : null;

        // 坐标字段形如 "(0,0)"
        const coordField = col(r, '坐标');
        const coordMatch = /\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(coordField);
        const x = coordMatch ? Number(coordMatch[1]) : null;
        const y = coordMatch ? Number(coordMatch[2]) : null;

        const condition = col(r, '条件').trim();

        // 条件里引用的开关名（形如 开关[第一天夜晚莉莉亚回家](需ON)）
        const needSwitchNames = [];
        for (const m of condition.matchAll(/开关\[([^\]]+)\]/g)) needSwitchNames.push(m[1]);
        const needVarNames = [];
        for (const m of condition.matchAll(/变量\[([^\]]+)\]/g)) needVarNames.push(m[1]);

        const storyId = Number(col(r, '故事序号')) || 0;

        triggers.push({
            storyId,
            source: col(r, '来源'),
            mapId,
            mapArea: mapId !== null ? (mapAreas.get(mapId) || '') : '',
            eventId: col(r, '事件ID'),
            eventName: col(r, '事件名'),
            x, y,
            page: col(r, '页'),
            pageIndex: /^\d+\//.test(col(r, '页')) ? Number(col(r, '页').split('/')[0]) - 1 : null,
            triggerType: col(r, '触发方式'),
            condition,
            needSwitchNames,
            needVarNames,
            // ⚠️ 这里**故意没有** line / speaker / lineCount —— 只有 storyId。
            //    UI 上那句台词预览由 server.js 在拼响应时从内存里的台词表补上
            //    （见 /api/triggers），没连游戏时就是空的，前端退回显示地图+坐标。
            // 有地图和坐标的才能"一键前往"
            actionable: mapId !== null && x !== null && y !== null,
        });
    }

    // 仅合并完全相同的候选；不同事件、页和条件必须保留。
    const seen = new Set();
    const uniqueTriggers = [];
    for (const t of triggers) {
        const k = `${t.storyId}|${t.mapId}|${t.eventId}|${t.page}|${t.x}|${t.y}|${t.condition}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniqueTriggers.push(t);
    }

    // ---- 常用开关：被触发点条件引用到的那些 ----
    // 这是"截图工作真正会用到的开关"的精确集合，用来做开关面板的默认视图
    const commonSwitchIds = [];
    for (const name of new Set(uniqueTriggers.flatMap(t => t.needSwitchNames))) {
        const id = switchNameToId.get(name);
        if (id !== undefined) commonSwitchIds.push(id);
    }
    commonSwitchIds.sort((a, b) => a - b);

    return {
        switches,
        variables,
        maps,
        triggers: uniqueTriggers,
        commonSwitchIds,
        switchNameToId,
        stats: {
            switches: switches.length,
            variables: variables.length,
            maps: maps.length,
            triggersTotal: triggers.length,
            triggersUnique: uniqueTriggers.length,
            triggersActionable: uniqueTriggers.filter(t => t.actionable).length,
            commonSwitches: commonSwitchIds.length,
            mapAreas: mapAreas.size,
            // 注意：storyLoaded / triggersWithLine **不在这里** ——
            // 台词要连上游戏才知道，它们是运行时值，由 server.js 的 /api/status 现算。
        },
    };
}

module.exports = { loadAll, parseCsv };
