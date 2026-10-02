const { installPhotoTools } = require('./photo-state');
const { chooseStoryPosition } = require('./story-position');
const { installTrainer } = require('./trainer');
const PHOTO = `const photo = (${installPhotoTools.toString()})();`;
// 游戏操作脚本库
//
// 这里每个函数都返回一段「将被送进游戏页面执行的 JavaScript 源码」。
// 之所以存成字符串而非直接执行，是因为这些代码必须在游戏进程里跑，
// 才能访问 $gamePlayer / $gameMap 这些游戏全局对象。
//
// ⚠️ 关键设计约束（来自 2026-10-02 实机探查，详见 aitemp/探查结果.md）：
//   1. 传送必须用 $gamePlayer.locate(x, y)，不能手写 _x/_y/_realX/_realY
//      —— 后者会漏掉物理引擎的 px/py，导致"画面过去了、碰撞体还在原地"
//   2. 游戏有 4 套坐标系，locate() 内部会一次同步全部
//   3. 无敌用 lockInvincible()（常驻）而非 makeInvincible()（会自己失效）
//   4. 工具不负责读档 —— CDP 读档会崩（物理网格无法反序列化）

/**
 * 包一层 IIFE，统一处理：游戏未进地图的守卫、异常捕获、JSON 返回格式。
 *
 * **用 async IIFE**，因为跨地图传送需要 `await` 等地图加载完
 * （`reserveTransfer` 是异步的，下一个 update 才真正切图）。
 * CDP 那边开了 `awaitPromise: true`，所以返回 Promise 会被自动等待。
 * 同步的操作写成 async 也无妨，只是多包一层 Promise。
 */
function wrap(body, { needMap = true } = {}) {
    const guard = needMap ? `
        if (typeof $gamePlayer === 'undefined' || !$gamePlayer ||
            typeof $gameMap === 'undefined' || !$gameMap || $gameMap.mapId() === 0 ||
            (typeof SceneManager !== 'undefined' && SceneManager._scene?.constructor.name !== 'Scene_Map')) {
            return JSON.stringify({ ok: false, error: '游戏还没进入地图。请先在游戏里读档或开始游戏。' });
        }
    ` : '';
    return `(async function(){ try { ${guard} ${body} } catch (e) { return JSON.stringify({ ok:false, error: String(e && e.message || e) }); } })()`;
}

/** 游戏里可用的「等一会儿」 */
const SLEEP = `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`;

/**
 * 防"坠落复位"的公共代码片段。
 *
 * 玩家和**莉莉娅是两个独立对象**，任何位置/物理改动都要两边都做 ——
 * 只处理玩家的话，同伴会掉进坑里、被坠落复位反复弹回，
 * 并且一直播 player_fall 音效（用户实测反馈过）。
 * 机制见开发文档第 6 节。
 */
const SAFE_CHAR = `
    // 清残留碰撞 + 重置落地锚点，否则 isFallDown() 会一直为真
    const safeChar = (c) => {
        if (!c) return;
        try {
            c.clearImpact && c.clearImpact();
            c._impact = null;
            c.clearGrounding && c.clearGrounding();
            c._groundingX = c._terrainGroundingX = c.px;
            c._groundingY = c._terrainGroundingY = c.py;
            c.vx = 0; c.vy = 0; c._vx = 0; c._vy = 0;
            c.dotX = 0; c.dotY = 0;
        } catch (e) {}
    };
    // 让角色进入悬浮状态（不接触地形，自然不会触发坠落判定）
    const floatChar = (c) => {
        if (!c) return;
        safeChar(c);
        try { c.suspendGravity(); c.suspendPhysicsHitTest(); } catch (e) {}
    };
    // 莉莉娅在不在（她被移除时不该动她）
    const lilyAny = () => typeof $gameLily !== 'undefined' ? $gameLily : null;
    const lilyHere = () => {
        try {
            return (typeof $gameLily !== 'undefined' && $gameLily
                    && !(($gameLily.isRemove && $gameLily.isRemove()))) ? $gameLily : null;
        } catch (e) { return null; }
    };
`;

const OPS = {
    // 发布版独有：从运行时对象表建立全文内存索引，不写文件。
    readStoryIndex() {
        return wrap(`
            if (typeof $dataStory === 'undefined' || !$dataStory) {
                return JSON.stringify({ ok: false, error: '$dataStory 不存在（游戏还没启动完？）' });
            }
            const out = {};
            for (const id of Object.keys($dataStory)) {
                if (!/^\\d+$/.test(id)) continue;
                const seq = $dataStory[id];
                if (!Array.isArray(seq) || !seq.length) continue;

                const lines = [];
                for (const c of seq) {
                    if (!c || c.name !== 'story') continue;
                    const text = String(c.contents === undefined || c.contents === null ? '' : c.contents).trim();
                    if (!text) continue;
                    if (text.startsWith('#') || text.startsWith('///')) continue;   // 指令 / 备注，不是台词
                    let speaker = '';
                    if (c.speaker !== undefined && c.speaker !== null && c.speaker !== '') {
                        const a = (typeof $dataActors !== 'undefined' && $dataActors) ? $dataActors[c.speaker] : null;
                        speaker = (a && a.name) ? String(a.name).trim() : '';
                    }
                    lines.push({ text: text, speaker: speaker });
                }
                if (!lines.length) continue;
                out[id] = { first: lines[0].text, speaker: lines[0].speaker, count: lines.length, lines,
                    searchText: lines.map(l => l.text + ' ' + l.speaker).join('\\n') };
            }
            if (!Object.keys(out).length) return JSON.stringify({ ok: false, error: '故事表尚未就绪或没有可读台词' });
            return JSON.stringify({ ok: true, index: out, count: Object.keys(out).length });
        `, { needMap: false });
    },

    trainer(body = null) {
        return wrap(`const trainer = (${installTrainer.toString()})();
            return JSON.stringify(${body ? `trainer.change(${JSON.stringify(body)})` : 'trainer.read()'});`);
    },
    /** 读取当前游戏状态（供控制面板顶栏显示） */
    snapshot() {
        return wrap(`
            if (window.__nyaruruPhoto?.touch) window.__nyaruruPhoto.touch();
            if (window.__nyaruruTrainer) window.__nyaruruTrainer.touch();
            const p = $gamePlayer, m = $gameMap;
            const mi = $dataMapInfos && $dataMapInfos[m.mapId()];
            let bo = null;
            try { bo = p.battleObject(); } catch (e) {}
            return JSON.stringify({
                ok: true,
                scene: SceneManager._scene && SceneManager._scene.constructor.name,
                mapId: m.mapId(),
                mapName: mi ? mi.name : ('地图 ' + m.mapId()),
                mapSize: [m.width(), m.height()],
                x: p._x,
                y: p._y,
                realX: p._realX,
                realY: p._realY,
                hp: bo ? bo.hp : null,
                gravitySuspended: !!p.isSuspendGravity(),
                invincible: !!p.isInvincible(),
                noclip: !!p._suspendPhysicsHitTest,
                // 莉莉娅在不在画面里（通关后她会一直跟着，可以用开关藏起来）
                lilyVisible: (typeof $gameLily !== 'undefined' && $gameLily && $gameLily.isRemove)
                    ? !$gameLily.isRemove() : null,
                tileSize: [m.tileWidth(), m.tileHeight()],
                realScale: Graphics._realScale,
                canvasSize: [Graphics.width, Graphics.height],
                stagedActors: window.__nyaruruPhoto ? window.__nyaruruPhoto.count() : 0,
                uiHidden: SceneManager._scene.__nyaruruUiHidden || {message:false, artwork:false, hud:false},
                switchesOn: (function(){ let n=0; for (let i=1;i<$dataSystem.switches.length;i++) if ($gameSwitches.value(i)) n++; return n; })(),
            });
        `);
    },

    /** 实机 NW.js 用 chrome-extension URL；身份以 Node 入口和实际存档目录为准。 */
    selfPath() {
        return wrap(`
            if (window.__nyaruruTrainer) window.__nyaruruTrainer.touch();
            if (!window.__nyaruruIdentity) Object.defineProperty(window, '__nyaruruIdentity', {
                value: { maps: new WeakMap(), next: 0, epoch: Date.now().toString(36) + Math.random().toString(36).slice(2) }
            });
            const state = window.__nyaruruIdentity;
            const player = typeof $gamePlayer !== 'undefined' && $gamePlayer;
            if (player && !state.maps.has(player)) state.maps.set(player, ++state.next);
            const mapData = typeof $dataMap !== 'undefined' && $dataMap;
            if (mapData && !state.maps.has(mapData)) state.maps.set(mapData, ++state.next);
            const mapId = typeof $gameMap !== 'undefined' && $gameMap ? $gameMap.mapId() : 0;
            const gameDir = require('path').dirname(process.mainModule.filename);
            const saveDir = typeof StorageManager !== 'undefined' ? StorageManager.fileDirectoryPath() : '';
            return JSON.stringify({ ok: true, gameDir, saveDir, href: String(location.href), pathname: String(location.pathname),
                mapToken: state.epoch + ':' + (player ? state.maps.get(player) : 0) + ':' + mapId + ':' + (mapData ? state.maps.get(mapData) : 0),
                mapId, inMap: typeof SceneManager !== 'undefined' && SceneManager._scene?.constructor.name === 'Scene_Map' });
        `, { needMap: false });
    },

    /**
     * 传送到指定格。
     *
     * ⚠️ 这个函数处理了一个**实测踩出来的坑**，改动前务必先读 `探查结果.md` 与开发文档第 6 节。
     *
     * 游戏的"坠落复位"机制（nya_statem.js:5986）：
     *   isFallDown() 在玩家碰到 type===2 的地形（坑、虚空）时返回 true，
     *   然后 updateFallDown() 会播 player_fall 音效并调 revertToLastGroundingPos()，
     *   把人弹回 `_terrainGroundingX/Y`（最后一次站在实地上位置）。
     *
     * 两个连带问题：
     *   1. 传送到坑里 → 立刻触发坠落复位，听起来像"掉出地图被弹回来"
     *   2. 如果是传送过来的、在本图从没真正落地过，`_terrainGroundingX/Y`
     *      还是**上一张地图的陈值** → 人被扔到画面外，表现为"人物消失"
     *
     * 所以传送必须做三件事（缺一不可）：
     *   a. 清掉残留碰撞信息，否则 isFallDown() 会一直为 true 而反复触发
     *      （穿墙状态下碰撞检测整个跳过，_impact 永远不会被自动清掉）
     *   b. 把两个"最后落地位置"锚点重置到目标点，让万一触发的复位落在正确位置
     *   c. 默认进入"悬浮安全模式"（暂停重力 + 穿墙），从根上不让角色接触地形
     *
     * 用户想真正站到地上走动时，调用 land()。
     */
    teleport(x, y, { float = true, mapId = null, story = null } = {}) {
        if (x === null || y === null || x === '' || y === '' || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('坐标必须是有限数值');
        if (mapId !== null && (!Number.isInteger(Number(mapId)) || Number(mapId) < 1)) throw new Error('地图编号无效');
        return wrap(`
            ${SLEEP}
            const p = $gamePlayer, m = $gameMap;
            const targetMap = ${mapId !== null && mapId !== undefined ? Number(mapId) : 'null'};
            const sameMap = (targetMap === null || targetMap === m.mapId());
            const fromMap = m.mapId();
            const previous = { x: p._x, y: p._y };

            const tx = Math.max(0, Math.min(m.width() - 1, Math.round(${Number(x)})));
            const ty = Math.max(0, Math.min(m.height() - 1, Math.round(${Number(y)})));

            if (!sameMap) {
                if (typeof $dataMapInfos === 'undefined' || !$dataMapInfos[targetMap]) return JSON.stringify({ok:false,error:'目标地图不存在'});
                if (window.__nyaruruPhoto) window.__nyaruruPhoto.unpinAll();
                // 跨地图：必须走游戏自己的 reserveTransfer，它会触发
                // Game_Map.setup() / completeLoad() 把新地图的事件、
                // 地形、物理网格全部重建好。直接改 mapId 是行不通的。
                //
                // ⚠️ 传送前必须关掉对话窗口。链路是这样的：
                //     updateTransferPlayer() → SceneManager.goto(Scene_Map)
                //   而 goto 只在场景"不忙"时生效，Scene_Map.isBusy() 在
                //   消息窗口未关闭时为 true。
                //   实测：残留的对话窗口会让跨地图传送一直卡到超时。
                let closedMessage = false;
                try {
                    closedMessage = $gameMessage.hasText ? $gameMessage.hasText() : false;
                    if (closedMessage) $gameMessage.clear();
                } catch (e) {}

                p.reserveTransfer(targetMap, tx, ty, 2, 0);   // 2=朝下, 0=黑屏渐变
                const t0 = Date.now();
                while (Date.now() - t0 < 12000) {
                    await sleep(100);
                    if ($gameMap !== m || $gamePlayer !== p) break;
                    if (m.mapId() === targetMap && !p.isTransferring() && SceneManager._scene?.constructor.name === 'Scene_Map') break;
                }
                if ($gameMap !== m || $gamePlayer !== p || m.mapId() !== targetMap || p.isTransferring() || SceneManager._scene?.constructor.name !== 'Scene_Map') {
                    if (p.clearTransferInfo) p.clearTransferInfo();
                    return JSON.stringify({
                        ok: false,
                        error: '跨地图传送超时：目标地图 ' + targetMap + ' 没能加载（当前仍在 ' + m.mapId() + '）。'
                             + '常见原因是场景被占用（对话窗口、菜单、演出），先在游戏里结束当前操作再试。',
                    });
                }
                // 换图后坐标可能被目标地图的出生点逻辑改过，再定一次位
                const nx = Math.max(0, Math.min(m.width() - 1, Math.round(${Number(x)})));
                const ny = Math.max(0, Math.min(m.height() - 1, Math.round(${Number(y)})));
                p.locate(nx, ny);
            } else {
                p.locate(tx, ty);
            }

            let storyPlacement = null;
            const storyRequest = ${JSON.stringify(story ? { eventId: Number(story.eventId), pageIndex: story.pageIndex == null ? null : Number(story.pageIndex), storyId: Number(story.storyId) } : null)};
            if (storyRequest) {
                storyPlacement = (${chooseStoryPosition.toString()})({ ...storyRequest, map: m, player: p, data: $dataMap,
                    sameMap, previous, requested: { x: p._x, y: p._y } });
                if (storyPlacement.ok) p.locate(storyPlacement.x, storyPlacement.y);
                else if (sameMap) p.locate(previous.x, previous.y);
            }

            // 清零速度，否则残留惯性会让角色传送后立刻滑走
            p.vx = 0; p.vy = 0;
            p._vx = 0; p._vy = 0;
            p.dotX = 0; p.dotY = 0;
            p.setMovementSuccess && p.setMovementSuccess(true);

            // (a) 清掉传送前残留的碰撞信息 —— 尤其是从致命地形带过来的 type===2
            p.clearImpact && p.clearImpact();
            p._impact = null;
            p.clearGrounding && p.clearGrounding();

            // (b) 重置"最后落地位置"锚点，否则坠落复位会把人弹到旧地图的陈值坐标
            p._groundingX = p._terrainGroundingX = p.px;
            p._groundingY = p._terrainGroundingY = p.py;

            // (c) 悬浮安全模式
            // ⚠️ 莉莉娅也要一起处理。她是独立对象，只让玩家悬浮的话，
            //    同伴会掉进坑里、被坠落复位反复弹回（用户实测反馈过）。
            const floatMode = ${float ? 'true' : 'false'};
            if (floatMode) {
                ${SAFE_CHAR}
                floatChar(p);
                const companion = lilyHere();
                if (!sameMap && storyPlacement?.ok && storyPlacement.controller && companion?.locate) companion.locate(p._x, p._y);
                floatChar(companion);
            }

            // 检测是否正在播放剧情 / 有事件在跑。
            // 演出期间角色的位置由事件系统接管，会立刻覆盖我们的传送
            // （实测表现为"传到 20 却停在 13"）。这种情况必须告诉用户，
            // 否则会以为是工具坏了。
            let busy = false;
            try {
                busy = m.isAnyEventStarting ? m.isAnyEventStarting() : false;
                if (!busy && m._updateEvents) {
                    busy = m._updateEvents.some(e => e && e.isStarting && e.isStarting());
                }
            } catch (e) { /* 检测失败不影响传送本身 */ }

            return JSON.stringify({
                ok: storyPlacement?.ok !== false, error: storyPlacement?.error,
                positionNote: storyPlacement?.positionNote,
                x: p._x, y: p._y, px: p.px, py: p.py,
                mapId: m.mapId(),
                changedMap: fromMap !== m.mapId(),
                float: floatMode,
                gravitySuspended: !!p.isSuspendGravity(),
                noclip: !!p._suspendPhysicsHitTest,
                busy: busy,
            });
        `);
    },

    /**
     * ★ 直接播放一段剧情序列。
     *
     * **为什么需要这个**：通关存档上，NPC 的事件页早就翻到后面去了，
     * 或者所需的开关组合已经变了，走过去根本不会触发那段对话。
     * 这条路绕开地图事件和开关条件，直接从指令层调用故事。
     *
     * 原理：把一条合成出来的 `call_story` 插件指令喂给地图解释器
     * （`$gameMap._interpreter.setup(list, 0)`），游戏自己就会当它是
     * 事件触发的，正常播放。
     *
     * 插件指令参数格式实测为 [插件名, 命令名, 显示文本, 参数对象] —— 4 个元素，
     * 参数在**第 3 位**（rmmz_objects.js:11315 的 command357 取的就是 params[3]）。
     */
    playStory(storyId) {
        return wrap(`
            ${SLEEP}
            const scenePlayer = $gamePlayer, sceneMap = $gameMap, sceneData = $dataMap;
            const stillHere = () => scenePlayer === $gamePlayer && sceneMap === $gameMap && sceneData === $dataMap;
            const id = ${Number(storyId)};
            if (!$dataStory || !$dataStory[id] || !$dataStory[id].length) {
                return JSON.stringify({ ok: false, error: '找不到故事序列 ' + id });
            }

            // ---- 播放前先彻底清场 ----
            // 如果不清理，上一条剧情的剩余指令会和新剧情排队执行，
            // 结果就是"请求播放 #16，画面上显示的却是别的剧情"（实测踩到过）。
            try {
                $gameMessage.clear();
                const it = $gameMap._interpreter;
                if (it) {
                    if (it._childInterpreter) it._childInterpreter.clear();
                    it.clear();
                }
            } catch (e) {}
            await sleep(150);   // 给游戏一帧时间把窗口收干净
            if (!stillHere()) return JSON.stringify({ok:false,error:'地图或存档已经变化，播放已取消'});

            // 已经读过的剧情会被游戏标记，某些情况下会走"跳过模式"一闪而过。
            // 显式重置一次，保证按正常速度播放，方便截图。
            try { $gameMessage.resetSkipMode(); } catch (e) {}

            const cmd = {
                indent: 0,
                code: 357,
                parameters: ['NYA.ACHIEVES_Adapter', 'call_story', '调用故事序列', { id: String(id) }],
            };
            $gameMap._interpreter.setup([cmd], 0);

            // 等它真的开始播（消息窗口出现文字）
            const t1 = Date.now();
            let started = false;
            while (Date.now() - t1 < 3000) {
                await sleep(80);
                if (!stillHere()) return JSON.stringify({ok:false,error:'地图或存档已经变化，播放已取消'});
                if ($gameMessage.hasText && $gameMessage.hasText()) { started = true; break; }
            }

            const shownText = ($gameMessage._texts && $gameMessage._texts[0]) || '';
            // 期望的首句台词，来自 $dataStory（第一条 story 指令的 contents）
            let expected = '';
            try {
                const first = $dataStory[id].find(c => c && c.name === 'story');
                expected = first ? String(first.contents || '') : '';
            } catch (e) {}

            return JSON.stringify({
                ok: true,
                started: started,
                lines: $dataStory[id].length,
                speaker: ($gameMessage._speakerName || ''),
                firstText: shownText,
                expected: expected,
                // 显示的不是这一段，说明有残留剧情串台了
                matched: !expected || shownText.startsWith(expected.slice(0, 8)),
            });
        `);
    },

    /**
     * ★ 运行整段过场（而不是只念台词）。
     *
     * **为什么需要这个**：`playStory()` 只调用 `call_story`，等于跳过了"导演"。
     * 实测反馈是"只有主角和对话框，在和虚空对话" —— 因为那些 NPC 是由
     * 事件页里前面的指令（移动、显示、等待）摆到位的，光念台词当然没人。
     *
     * 定位方式：在当前地图上找**哪一页含目标故事的 call_story**，
     * 比信任 CSV 里的页码更可靠（页码是 1-based，而且可能和实际不符）。
     *
     * 起始位置按**目标指令的缩进**决定（详见函数内注释）：
     * 在条件分支里就从目标指令开始跑，否则从页头跑。
     */
    runStoryScene(storyId, eventId = null, pageIndex = null) {
        return wrap(`
            ${SLEEP}
            const scenePlayer = $gamePlayer, sceneMap = $gameMap, sceneData = $dataMap;
            const stillHere = () => scenePlayer === $gamePlayer && sceneMap === $gameMap && sceneData === $dataMap;
            ${SAFE_CHAR}
            const id = ${Number(storyId)};
            const m = $gameMap;

            // 找到含这段 call_story 的事件页，**同时记下它在指令列表里的位置和缩进**
            let found = null;
            for (const ev of m.events()) {
                if (!ev) continue;
                if (${eventId === null ? 'false' : 'ev.eventId() !== ' + Number(eventId)}) continue;
                const data = ev.event();
                if (!data || !data.pages) continue;
                data.pages.forEach((pg, idx) => {
                    if (${pageIndex === null ? 'false' : 'idx !== ' + Number(pageIndex)}) return;
                    if (found) return;
                    const list = pg.list || [];
                    const ci = list.findIndex(c => {
                        if (c.code !== 357) return false;
                        const p = c.parameters || [];
                        if (p[1] !== 'call_story') return false;
                        const arg = p[p.length - 1];
                        return arg && Number(arg.id) === id;
                    });
                    if (ci >= 0) {
                        found = {
                            eventId: ev.eventId(), pageIndex: idx, list: list,
                            name: data.name, cmdIndex: ci,
                            indent: list[ci].indent || 0,
                        };
                    }
                });
                if (found) break;
            }

            if (!found) {
                return JSON.stringify({ ok: false, error: '当前地图上找不到含故事 ' + id + ' 的事件页。可能触发点在别的地图。' });
            }

            // 清场，避免和正在播的东西打架
            try {
                $gameMessage.clear();
                if (m._interpreter) {
                    if (m._interpreter._childInterpreter) m._interpreter._childInterpreter.clear();
                    m._interpreter.clear();
                }
            } catch (e) {}
            await sleep(200);
            if (!stillHere()) return JSON.stringify({ok:false,error:'地图或存档已经变化，播放已取消'});

            /*
             * ★ 从哪儿开始跑，取决于目标指令在不在条件分支里。
             *
             * 事件页常常是个"分支选择器"：按开关/独立开关挑一条支线播。
             * 例：地图 191 的 EV003 第 0 页，98 条指令里有 358 / 357 / 356 三个
             * call_story 分布在不同分支里。从页头跑会走**游戏状态选中的那条**，
             * 于是"点了 356 却播 358"（用户实际踩到）。
             *
             * 判据是缩进：顶层指令 indent=0，分支体内的指令 indent>=1。
             *   · indent > 0 → 目标在分支里 → **从目标指令开始跑**，保证播的是它
             *   · indent = 0 → 目标在顶层 → 从页头跑，前面的摆位/演出也一并执行
             *     （地图 6 的 EV009 就是这种：开头一堆 moveTo 把 NPC 摆好，再 call_story）
             */
            const insideBranch = found.indent > 0;

            /*
             * ★ 让"说话者事件"本身也有身体。
             *
             * 事件的形象是**跟着页走**的：页不对，画面上就只有对话框没有人
             * （用户实测反馈"和虚空对话"）。
             *
             * 这里只处理**触发这段故事的那一个事件**，不做全图扫描 ——
             * 实测地图 191 有 4 个事件（EV003/004/006/007）第 0 页都是
             * battleObject 202（同一个 laine_stand），全图拉一遍就会出现
             * **4 个一模一样的莲**（用户反馈"3 个一样的莲，奇奇怪怪的"）。
             */
            let speakerBody = null;
            let speakerPick = null;      // {ev, page}，等过场跑起来之后再应用
            try {
                const se = m.events().filter(Boolean).find(e => e.eventId() === found.eventId);
                if (se && !(se.characterName && se.characterName())) {
                    const sd = se.event();
                    const T = (typeof Game_BattleObject !== 'undefined') && Game_BattleObject._template;
                    // 返回某一页会给事件什么身体（没有则空串）
                    const bodyOfPage = (pg) => {
                        const cn = String((pg.image && pg.image.characterName) || '');
                        if (cn) return cn;
                        const ai = (pg.list || []).find(c => c.code === 357 && (c.parameters || [])[1] === 'ai');
                        if (ai) {
                            const a = (ai.parameters || []).slice(-1)[0];
                            const bo = a && a.battleObject;
                            if (bo !== undefined && bo !== '' && bo !== '0') {
                                const t = T && T[bo];
                                const s = t && (t.standingImage || t.movingImage);
                                if (s) return String(s);
                            }
                        }
                        return '';
                    };

                    let proper = -1;
                    try { proper = se.findProperPageIndex ? se.findProperPageIndex() : -1; } catch (e) {}
                    let pick = -1;
                    // 优先"条件本来就该选中的那页"，否则第一个有身体的页
                    if (proper >= 0 && sd.pages[proper] && bodyOfPage(sd.pages[proper])) pick = proper;
                    else {
                        for (let i = 0; i < sd.pages.length; i++) {
                            if (bodyOfPage(sd.pages[i])) { pick = i; break; }
                        }
                    }

                    if (pick >= 0) {
                        speakerPick = { ev: se, page: pick };
                    } else {
                        speakerBody = { forced: false, reason: '这个事件的任何一页都没有立绘，救不了' };
                    }
                } else if (se) {
                    speakerBody = { forced: false, sprite: String(se.characterName()), reason: '本来就有身体' };
                }
            } catch (e) {
                speakerBody = { error: String(e && e.message || e) };
            }

            m._interpreter.setup(found.list, found.eventId);
            if (insideBranch) m._interpreter._index = found.cmdIndex;

            // 等对话窗口出现（过场前面可能先有移动、等待等指令）
            const t0 = Date.now();
            let started = false;
            while (Date.now() - t0 < 8000) {
                await sleep(100);
                if (!stillHere()) return JSON.stringify({ok:false,error:'地图或存档已经变化，播放已取消'});
                if ($gameMessage.hasText && $gameMessage.hasText()) { started = true; break; }
            }

            /*
             * ★ 补身体必须放在**过场跑起来之后**，不能提前。
             *
             * 过场前面的指令会改开关/变量 → 触发 Game_Map.requestRefresh() →
             * 游戏下一帧把所有事件的页号**重算一遍**，提前设好的页会被冲掉。
             * 实测踩到：设完页、跑完过场，角色的身体又没了（开发文档第 6 节）。
             * 等对话窗口出现（过场已跑完、正等着玩家按键）再设，就稳了。
             */
            if (speakerPick) {
                ${PHOTO}
                const se = speakerPick.ev;
                photo.pin(se, speakerPick.page);
                speakerBody = { page: speakerPick.page, sprite: String(se.characterName()), forced: true, pinned: true, spriteFixed: true };

                /*
                 * ★ 把玩家挪开一格。
                 *
                 * 传送是把玩家送到"触发点坐标"，而说话者事件通常**就站在那个坐标上**
                 * —— 两个人重叠，画面上只看得到玩家（实测：莲在 (4,5)，玩家也在 (4,5)，
                 * 截图里完全没有莲）。
                 *
                 * ⚠️ 挪动必须走**和 teleport 一样的清理流程**，不能只 locate()。
                 *    实测只 locate() 会让玩家掉进坑里、被坠落复位反复弹回
                 *    （用户反馈"主角掉下去一直被传送回来又继续掉下去"）。
                 *    原因见开发文档第 6 节：残留的 _impact + 陈旧的落地锚点会让
                 *    isFallDown() 恒为真。这里照抄 teleport 里那套安全动作。
                 */
                const p = $gamePlayer;
                if (se._x === p._x && se._y === p._y) {
                    /*
                     * ⚠️ 方向**优先左右**，不要优先上下。
                     *
                     * 这类游戏是"站在某一行地板上"的表现方式：往下挪一格等于
                     * 站到地板**里面**，画面上主角会显得陷进去、和对方不在一个高度
                     * （用户实测反馈"主角明显和莲不在一个高度上面…在地板下面"）。
                     * 同一行左右相邻才是自然站位。
                     */
                    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];   // 左 右 上 下
                    for (const [dx, dy] of dirs) {
                        const nx = se._x + dx, ny = se._y + dy;
                        if (nx < 0 || ny < 0 || nx >= m.width() || ny >= m.height()) continue;

                        p.locate(nx, ny);
                        // 用和 teleport 同一套安全处理（清残留碰撞 + 重置锚点 + 悬浮）
                        floatChar(p);
                        // 莉莉娅跟着一起处理，否则她会掉下去、坠落复位反复触发
                        const lh = lilyHere();
                        if (lh) { floatChar(lh); }
                        speakerBody.playerMovedTo = [nx, ny];
                        break;
                    }
                }
                // 主角可能刚从同一格让开，必须按最终站位给摆拍说话者定朝向。
                photo.facePlayer?.(se);
            }

            const played = String($gameMessage._storyId || '');

            return JSON.stringify({
                ok: true,
                started: started,
                eventId: found.eventId,
                eventName: found.name,
                pageIndex: found.pageIndex,
                commands: found.list.length,
                // 从哪开始跑的，以及播出来的是不是用户选的那段
                insideBranch: insideBranch,
                startAt: insideBranch ? found.cmdIndex : 0,
                startIndex: insideBranch ? found.cmdIndex : 0,
                // 说话者事件的身体有没有被补上（只有触发这段故事的那一个事件）
                speakerBody: speakerBody,
                playedStoryId: played,
                matched: played === String(id),
                // 在分支里时前面那些摆位指令被跳过了，场景里的 NPC 可能不全
                skippedSetup: insideBranch ? found.cmdIndex : 0,
                speaker: ($gameMessage._speakerName || ''),
                firstText: ($gameMessage._texts && $gameMessage._texts[0]) || '',
            });
        `);
    },

    /**
     * 扫描本图"本该可见却没出现"的事件。
     *
     * 两种情况都算（判据来自开发文档第 6 节 的实测结论）：
     *   1. **被抹除**：`_erased === true`。游戏把 RM 原版的选页函数改成了
     *      `_pageIndex = this._erased ? -1 : this.findProperPageIndex()`，
     *      所以被抹除的事件页号被钉死在 -1，**补开关永远救不回来**
     *      （`Game_Event.updateParallel` → `command214`「暂时消除事件」）
     *   2. **页号没选中带立绘的那页**：当前页没立绘，但别的页有
     *
     * 只列出**至少有一页带立绘**的事件 —— 任何页都没立绘的（身体来自运行时 AI）
     * 是救不了的，列出来只会误导用户（见开发文档第 6 节 情况 B）。
     */
    scanLostEvents() {
        return wrap(`
            const m = $gameMap;
            const lost = [];
            const visible = [];

            // ⚠️ 判断"事件现在有没有身体"必须用 characterName()，不能只看
            //    page.image.characterName —— 实测地图 45 的 EV005 等事件，
            //    image 是空的，身体是通过事件页里的 ai 指令
            //    （{"battleObject":"61"}）在运行时挂上去的。
            //    只看 image 会把明明在场的角色误报成"丢失"（踩过）。
            const bodyOf = (ev) => {
                try { return String(ev.characterName ? ev.characterName() : ''); }
                catch (e) { return ''; }
            };

            // 把 battleObject 编号解析成真实立绘名。
            // 事件页里的 ai 指令存的是 {"battleObject":"202"} 这种编号，
            // 直接给用户看等于没说 —— 实测用户拿到"battleObject 202"完全没法判断
            // 该不该拉出来。真正的立绘名在战斗对象模板的 standingImage 里。
            const resolveSprite = (bo) => {
                try {
                    const T = (typeof Game_BattleObject !== 'undefined') && Game_BattleObject._template;
                    const t = T && T[bo];
                    const s = t && (t.standingImage || t.movingImage);
                    return s ? String(s) : ('battleObject ' + bo);
                } catch (e) { return 'battleObject ' + bo; }
            };

            for (const ev of m.events()) {
                if (!ev) continue;
                const d = ev.event();
                if (!d || !d.pages || !d.pages.length) continue;

                // 当前就看得见 → 记下来，不算丢失
                if (bodyOf(ev)) {
                    visible.push({ id: ev.eventId(), sprite: bodyOf(ev), x: ev._x, y: ev._y });
                    continue;
                }

                // 找出所有"有图像的页"。判据放宽到两种：
                //   a. 页自带的 image（characterName / tileId）
                //   b. 页的指令里有 ai 配置（battleObject）—— 运行时才长出身体
                const spritePages = [];
                d.pages.forEach((pg, i) => {
                    const cn = String((pg.image && pg.image.characterName) || '');
                    if (cn) { spritePages.push({ page: i, sprite: cn, via: 'image' }); return; }
                    const ai = (pg.list || []).find(c => c.code === 357
                        && (c.parameters || [])[1] === 'ai');
                    if (ai) {
                        const arg = (ai.parameters || [])[(ai.parameters || []).length - 1];
                        const bo = arg && arg.battleObject;
                        if (bo !== undefined && bo !== '' && bo !== '0') {
                            spritePages.push({ page: i, sprite: resolveSprite(bo), via: 'ai', battleObject: bo });
                        }
                    }
                });
                if (!spritePages.length) continue;      // 任何页都没身体 → 救不了，不列

                let proper = -1;
                try { proper = ev.findProperPageIndex ? ev.findProperPageIndex() : -1; } catch (e) {}
                const erased = !!ev._erased;

                // 建议页：优先"条件本来就该选中的那页"，否则第一个有身体的页
                const hit = spritePages.find(s => s.page === proper) || spritePages[0];

                lost.push({
                    id: ev.eventId(),
                    name: d.name,
                    x: ev._x, y: ev._y,
                    erased: erased,
                    currentPage: ev._pageIndex,
                    properPage: proper,
                    suggestPage: hit.page,
                    suggestSprite: hit.sprite,
                    suggestVia: hit.via,
                    spritePages: spritePages,
                });
            }

            return JSON.stringify({
                ok: true, mapId: m.mapId(),
                lost: lost, count: lost.length,
                visible: visible, visibleCount: visible.length,
            });
        `);
    },

    /**
     * 强行把事件切到指定页，让它带着立绘出现。
     *
     * ⚠️ 三条实测得来的硬性约束（开发文档第 6 节）：
     *   1. **页号必须做边界检查** —— 越界时 `setupPageSettings()` 会抛
     *      `TypeError: Cannot read properties of undefined (reading 'image')`
     *   2. 静态摆拍由 photo-state 管理，冻结事件更新；撤销时恢复原始字段。
     *   3. **要清 `_erased`** —— 否则下一次 refresh 会把它打回 -1
     *
     * 这是**摆拍**：被抹除的事件强行拉出来，它不会执行任何指令，
     * 只是一个站着的立绘。UI 上必须跟用户说清楚。
     */
    forcePage(eventId, pageIndex) {
        return wrap(`
            const m = $gameMap;
            const id = ${Number(eventId)};
            const want = ${Number(pageIndex)};

            const ev = m.events().filter(Boolean).find(e => e.eventId() === id);
            if (!ev) return JSON.stringify({ ok: false, error: '本图找不到事件 ' + id });

            const d = ev.event();
            if (!d || !d.pages) return JSON.stringify({ ok: false, error: '事件 ' + id + ' 没有页数据' });

            // (1) 边界检查 —— 不做的话会抛异常
            const n = d.pages.length;
            if (!Number.isInteger(want) || want < 0 || want >= n) {
                return JSON.stringify({ ok: false, error: '页号越界：' + want + '（该事件共 ' + n + ' 页，合法范围 0~' + (n - 1) + '）' });
            }

            ${PHOTO}
            const wasErased = !!ev._erased;
            photo.pin(ev, want);

            const cn = String(ev.characterName ? ev.characterName() : '');

            return JSON.stringify({
                ok: true,
                id: id, name: d.name,
                page: ev._pageIndex,
                sprite: cn,
                wasErased: wasErased,
                visible: !!cn,
                pinned: true,
                warning: wasErased
                    ? '这个事件原本被游戏自己抹除了，强拉出来只是"站着的立绘"，不会执行任何指令'
                    : '',
            });
        `);
    },

    /**
     * 一键还原本图所有"丢失"的角色（扫描 + 逐个强切）。
     *
     * ⚠️ 这是**摆拍**。调用方应当：
     *   - 在 UI 上明确标注
     *   - 提示摆拍状态不保证跨读档恢复，保存由用户决定。
     */
    restoreLostCast({ includeHidden = false } = {}) {
        return wrap(`
            ${PHOTO}
            const m = $gameMap;
            const results = [];
            const skipped = [];

            const bodyOf = (ev) => { try { return String(ev.characterName ? ev.characterName() : ''); } catch (e) { return ''; } };

            for (const ev of m.events()) {
                if (!ev) continue;
                const d = ev.event();
                if (!d || !d.pages || !d.pages.length) continue;

                const spritePages = [];
                d.pages.forEach((pg, i) => {
                    const cn = String((pg.image && pg.image.characterName) || '');
                    if (cn) { spritePages.push({ page: i, sprite: cn, via: 'image' }); return; }
                    const ai = (pg.list || []).find(c => c.code === 357 && (c.parameters || [])[1] === 'ai');
                    if (ai) {
                        const arg = (ai.parameters || [])[(ai.parameters || []).length - 1];
                        const bo = arg && arg.battleObject;
                        if (bo !== undefined && bo !== '' && bo !== '0') {
                            spritePages.push({ page: i, sprite: 'battleObject ' + bo, via: 'ai' });
                        }
                    }
                });
                if (!spritePages.length) continue;

                if (bodyOf(ev)) continue;                 // 已经看得见

                const wasErased = !!ev._erased;
                let proper = -1;
                try { proper = ev.findProperPageIndex ? ev.findProperPageIndex() : -1; } catch (e) {}

                // ★ 区分两种情况：
                //   1. 被抹除的（wasErased）—— 该在场上却被游戏删了，拉出来是**正当恢复**
                //   2. 没被抹除、但游戏选的页没身体 —— 游戏是**有意**不显示它
                //      （比如剧情推进到后面了，这个 NPC 本来就该退场）
                //      强拉出来会凭空多出人物，画面上是没发生过的事。
                //      默认不动它们，除非调用方明确要求。
                if (!wasErased && !${includeHidden ? 'true' : 'false'}) {
                    skipped.push({
                        id: ev.eventId(), name: d.name,
                        properPage: proper,
                        reason: '游戏有意隐藏（不是被抹除）',
                    });
                    continue;
                }

                const pick = spritePages.find(s => s.page === proper) || spritePages[0];
                photo.pin(ev, pick.page);

                results.push({
                    id: ev.eventId(), name: d.name,
                    page: pick.page, sprite: pick.sprite, via: pick.via,
                    wasErased: wasErased,
                    x: ev._x, y: ev._y,
                });
            }

            // 检查"多个事件显示成同一个立绘"的情况。
            // 实测地图 191 有 4 个事件（EV003/004/006/007）第 0 页都是同一个
            // battleObject —— 全拉出来会变成好几个一模一样的人（用户反馈过
            // "3 个一样的莲，奇奇怪怪的"）。这里如实报出来，别让用户自己数。
            const bySprite = {};
            for (const r of results) { bySprite[r.sprite] = (bySprite[r.sprite] || 0) + 1; }
            const duplicates = Object.keys(bySprite)
                .filter(k => bySprite[k] > 1)
                .map(k => ({ sprite: k, count: bySprite[k] }));

            return JSON.stringify({
                ok: true,
                restored: results.length,
                list: results,
                erasedCount: results.filter(r => r.wasErased).length,
                skipped: skipped,
                skippedCount: skipped.length,
                duplicates: duplicates,
                includeHidden: ${includeHidden ? 'true' : 'false'},
            });
        `);
    },

    /**
     * 取消本图所有"钉住"的页号，让游戏恢复自己选页。
     *
     * 强切页现在是靠**覆盖 `findProperPageIndex`** 实现的，所以会一直生效
     * （扛得住开关/变量变动引起的重算）。用完想恢复原状时调这个。
     */
    unpinPages() {
        return wrap(`
            const n = window.__nyaruruPhoto ? window.__nyaruruPhoto.unpinAll() : 0;
            return JSON.stringify({ok:true,unpinned:n});
        `);
    },

    /**
     * 把当前游戏状态存进指定槽。允许摆拍时保存，不承诺跨读档恢复摆拍。
     *
     * 存档是 zlib + main.y() 加密的，外部改不了；但可以让**游戏自己存** ——
     * `DataManager.saveGame()` 走的就是游戏自己的加密路径。
     * 实测无弹窗、不需要玩家交互、`_globalInfo` 立即更新（开发文档第 6 节）。
     *
     * ⚠️ **会覆盖该槽位原有的进度。** 调用方必须先备份、并让用户明确选槽。
     * 实测 24 个槽位（0=自动存档，1~23 手动）在用户的档里全满，没有空槽可用。
     *
     * 注意：这是"存"不是"读"。读档仍然必须走游戏自己的标题界面（见开发文档第 3 节）。
     */
    savePhotoSlot(slot) {
        return wrap(`
            ${SLEEP}
            const s = ${Number(slot)};
            const max = DataManager.maxSavefiles();
            if (!Number.isInteger(s) || s < 1 || s > max) {
                return JSON.stringify({ ok: false, error: '槽位越界：' + s + '（合法范围 1~' + max + '，0 是自动存档槽）' });
            }
            try {
                const pending = [], originalZip = StorageManager.saveZip, originalObject = StorageManager.saveObject;
                StorageManager.saveZip = function(...args) { const job = originalZip.apply(this, args); pending.push(Promise.resolve(job)); return job; };
                StorageManager.saveObject = function(...args) { const job = originalObject.apply(this, args); pending.push(Promise.resolve(job)); return job; };
                try {
                    $gameSystem.onBeforeSave();
                    SceneManager.snapForBackground();
                    await DataManager.saveGame(s);
                    for (let i = 0; i < pending.length; i++) await pending[i];
                } finally { StorageManager.saveZip = originalZip; StorageManager.saveObject = originalObject; }
                return JSON.stringify({
                    ok: true, slot: s,
                    mapId: $gameMap.mapId(),
                    x: $gamePlayer._x, y: $gamePlayer._y,
                });
            } catch (e) {
                return JSON.stringify({ ok: false, error: '存档失败: ' + String(e && e.message || e) });
            }
        `);
    },

    /**
     * 拍照辅助：隐藏 / 显示画面上的各种 UI。
     *
     * 三个开关互不影响，各自可以 null（表示"别动它"）：
     *   message —— 对话框（消息窗口 + 选项窗口）
     *   artwork —— 立绘
     *   hud     —— 游戏 HUD（血条、小地图、Boss 条、存档条等）
     *
     * ⚠️ 与 `closeMessage()` 的区别：
     *   - `closeMessage()` 是**真的关掉**对话（清空消息、停掉剧情），关了就回不来了
     *   - 这个只是**把窗口藏起来**，随时能显示回来。想拍"有对话框"和"没对话框"
     *     两张对照图，用这个。
     *
     * 实现上是直接改 `visible`。游戏每帧不会强制改回来（实测），
     * 但如果窗口自己重开了（比如新的对话），需要再调一次。
     */
    setUiHidden(opts = {}) {
        const m = opts.message, a = opts.artwork, h = opts.hud;
        const arg = (v) => (v === null || v === undefined) ? 'null' : (v ? 'true' : 'false');
        return wrap(`
            const sc = SceneManager._scene;
            if (!sc || sc.constructor.name !== 'Scene_Map') {
                return JSON.stringify({ ok: false, error: '当前不在地图场景（请先读档进入游戏）' });
            }

            // 游戏 HUD 的字段名（实测自 Scene_Map，见开发文档 4.x）
            const HUD = ['_floatingSoftGuideBar','_weaponChange','_damageDigit','_playerBar',
                         '_enemyBar','_smallMap','_bossBar','_autoSaveBar','_skipStory',
                         '_ornamentsUI','_battleBar','_bossRushPanel','_taskNotificationBar',
                         '_notificationBar','_bossDestination','_playerFloatingTips',
                         '_zxCArtwork','_mapThumbnailBig','_artwork'];

            const put = (v, visible) => { if (v && typeof v === 'object') v.visible = visible; };
            const applied = {};

            const wantMsg = ${arg(m)};
            if (wantMsg !== null) {
                put(sc._messageWindow, !wantMsg);
                put(sc._choiceWindow, !wantMsg);
                put(sc._eventItemWindow, !wantMsg);
                applied.message = wantMsg;
            }

            const wantArt = ${arg(a)};
            if (wantArt !== null) {
                // ⚠️ 立绘不能只改父容器的 visible —— Sprite_Artwork 自己的状态机
                //    每帧会把它改回来（实测 1.8 秒内恢复 true）。
                //    必须连**子精灵**一起藏，那个不会被改回去。
                put(sc._artwork, !wantArt);
                let n = 0;
                if (sc._artwork && sc._artwork.children) {
                    for (const c of sc._artwork.children) {
                        if (c && c.visible !== undefined) { c.visible = !wantArt; n++; }
                    }
                }
                applied.artwork = wantArt;
                applied.artworkParts = n;
            }

            const wantHud = ${arg(h)};
            if (wantHud !== null) {
                let n = 0;
                for (const k of HUD) {
                    if (k === '_artwork') continue;          // 立绘单独控制
                    if (sc[k] && typeof sc[k] === 'object' && sc[k].visible !== undefined) {
                        sc[k].visible = !wantHud; n++;
                    }
                }
                applied.hud = wantHud;
                applied.hudCount = n;
            }

            sc.__nyaruruUiHidden = { ...(sc.__nyaruruUiHidden || {message:false,artwork:false,hud:false}) };
            for (const k of ['message','artwork','hud']) if (applied[k] !== undefined) sc.__nyaruruUiHidden[k] = applied[k];
            return JSON.stringify({ ok: true, applied: applied, state: sc.__nyaruruUiHidden });
        `);
    },

    /**
     * 莉莉娅（跟随的同伴）显示 / 隐藏。
     *
     * 用的是游戏自己的 API —— 插件指令 `setLilyPartner` 内部就是
     * `$gameLily.setRemove(args.open !== "true")`（NYA.EVENT.AI_Adapter.js:1293）。
     *
     * ⚠️ 如果原场景里莉莉娅本来就该在场，把她藏起来会让画面和原作不符。
     * UI 上要说清楚这一点。
     */
    setLily(show) {
        return wrap(`
            if (typeof $gameLily === 'undefined' || !$gameLily) {
                return JSON.stringify({ ok: false, error: '当前没有莉莉娅这个对象' });
            }
            $gameLily.setRemove(${show ? 'false' : 'true'});
            return JSON.stringify({ ok: true, visible: !$gameLily.isRemove() });
        `);
    },

    /**
     * 关掉当前的消息窗口，并停掉正在播放的剧情。
     * 截完图收尾用 —— 否则对话窗口会一直挂在那儿等输入。
     */
    closeMessage() {
        return wrap(`
            let closed = false;
            try {
                closed = $gameMessage.hasText ? $gameMessage.hasText() : false;
                $gameMessage.clear();
            } catch (e) {}

            // 解释器可能卡在等待消息的状态，一起清掉，否则它会继续跑后面的指令
            try {
                const it = $gameMap._interpreter;
                if (it) {
                    if (it._childInterpreter) it._childInterpreter.clear();
                    if (it.isRunning()) it.clear();
                }
            } catch (e) {}

            return JSON.stringify({ ok: true, hadMessage: closed });
        `);
    },

    /**
     * 探测当前位置脚下是什么，供"落地"判断安不安全。
     *
     * 实现要点（都是踩过坑才写对的）：
     *   1. 用 hitPreview(0, dy) 从当前位置往下逐段测碰撞（它会临时挪动碰撞体再还原）
     *   2. **必须用 `o.terrain === true` 过滤出地形**。直接取第一个碰撞对象是错的——
     *      同伴角色（$gameLily）常常和玩家重叠，会把"撞到同伴"误判成"脚下有地面"。
     *      实测：Game_Terrain 的 terrain 为 true，玩家和同伴都是 false。
     *   3. 步进用 1/4 格。用 1/2 格会跳过薄地形（实测同一位置 1/2 格测得 336px、
     *      1/4 格测得 312px，差了半格多）。
     *   4. type === 2 是"碰到会掉血/复位"的致命地形（坑、虚空）
     */
    probeGround() {
        return wrap(`
            const p = $gamePlayer, m = $gameMap;
            const th = m.tileHeight();
            const step = Math.max(8, Math.round(th / 4));
            const maxScan = (m.height() - p._y) * th + th;
            let found = null, hazard = false, scanned = 0;

            for (let dy = 0; dy <= maxScan; dy += step) {
                scanned++;
                const hit = p.hitPreview(0, dy);
                if (!hit || !hit.length) continue;

                // 只看地形，忽略角色和道具（否则会被同伴挡出误判）
                const terrains = hit.filter(o => o && o.terrain === true);
                if (!terrains.length) continue;

                if (terrains.some(o => o.type === 2)) hazard = true;
                else found = dy;
                break;
            }

            return JSON.stringify({
                ok: true,
                distance: found,      // 距脚下实地的像素数，null 表示没找到
                hazard: hazard,       // 正下方是致命地形
                clear: found !== null && !hazard,
                scanned: scanned,
                step: step,
            });
        `);
    },

    /**
     * 落地：让人从悬浮状态站到实地上。
     * 先探测脚下，正下方是坑就拒绝执行并说明原因，避免再踩一次坠落复位。
     */
    land() {
        return wrap(`
            const p = $gamePlayer, m = $gameMap;
            const th = m.tileHeight();
            const step = Math.max(8, Math.round(th / 4));
            const maxScan = (m.height() - p._y) * th + th;
            let found = null, hazard = false;

            for (let dy = 0; dy <= maxScan; dy += step) {
                const hit = p.hitPreview(0, dy);
                if (!hit || !hit.length) continue;
                const terrains = hit.filter(o => o && o.terrain === true);
                if (!terrains.length) continue;
                if (terrains.some(o => o.type === 2)) hazard = true;
                else found = dy;
                break;
            }

            if (hazard) {
                return JSON.stringify({ ok: false, error: '当前位置正下方是陷阱地形（掉下去会被弹回原位）。横向挪几格再试。' });
            }
            if (found === null) {
                return JSON.stringify({ ok: false, error: '当前位置下方没有可站立的地面（可能是无底洞）。横向挪几格再试。' });
            }

            // 恢复碰撞；锚点设到落点，确保万一出岔子也落在附近而不是旧地图的位置
            p.resumePhysicsHitTest();
            p.clearImpact && p.clearImpact();
            p._impact = null;
            p._groundingX = p._terrainGroundingX = p.px;
            p._groundingY = p._terrainGroundingY = p.py;
            p.resumeGravity();

            ${SAFE_CHAR}
            const lily = lilyAny();
            let lilyLanded = !lily, warning = '';
            if (lily) {
                let safe = !!(lily.isRemove && lily.isRemove());
                for (let dy = 0; !safe && dy <= Math.max(0, (m.height() - lily._y) * th + th); dy += step) {
                    const hits = (lily.hitPreview(0, dy) || []).filter(o => o && o.terrain === true);
                    if (hits.length) { safe = !hits.some(o => o.type === 2); break; }
                }
                if (safe) { safeChar(lily); lily.resumeGravity(); lily.resumePhysicsHitTest(); lilyLanded = true; }
                else { floatChar(lily); warning = '主角已落地；莉莉娅脚下不安全，仍保持悬浮。请移动到安全地面再点落地'; }
            }
            return JSON.stringify({ ok: true, dropDistance: found, lilyLanded, warning });
        `);
    },

    /** 读取所有开关的当前值（360 个布尔，数据量很小） */
    readSwitches() {
        return wrap(`
            const out = {};
            for (let i = 1; i < $dataSystem.switches.length; i++) {
                out[i] = $gameSwitches.value(i) ? 1 : 0;
            }
            return JSON.stringify({ ok: true, values: out });
        `);
    },

    /** 设置单个开关 */
    setSwitch(id, value) {
        return wrap(`
            const id = ${Number(id)};
            $gameSwitches.setValue(id, ${value ? 'true' : 'false'});
            return JSON.stringify({ ok: true, id: id, value: $gameSwitches.value(id) });
        `);
    },

    /** 批量设置开关（杀手锏功能"一键满足条件"会用到） */
    setSwitches(pairs) {
        return wrap(`
            const pairs = ${JSON.stringify(pairs)};
            const done = [];
            for (const [id, v] of pairs) {
                $gameSwitches.setValue(Number(id), !!v);
                done.push([id, $gameSwitches.value(Number(id))]);
            }
            return JSON.stringify({ ok: true, applied: done.length });
        `);
    },

    /**
     * 关重力 / 开重力。
     * ⚠️ 莉莉娅要一起处理：她是独立对象，只关玩家的重力，同伴会掉下去
     * 并触发坠落复位循环（用户实测反馈过）。
     */
    setGravity(suspended) {
        const on = suspended ? 'true' : 'false';
        return wrap(`
            ${SAFE_CHAR}
            const p = $gamePlayer;
            const lh = lilyAny();
            if (${on}) {
                floatChar(p);
                if (lh) floatChar(lh);
            } else {
                p.resumeGravity();
                p.resumePhysicsHitTest();
                if (lh) { lh.resumeGravity(); lh.resumePhysicsHitTest(); }
            }
            return JSON.stringify({
                ok: true,
                suspended: !!p.isSuspendGravity(),
                lilyTouched: !!lh,
            });
        `);
    },

    /** 无敌开关（用 lockInvincible，常驻且不会让角色闪烁） */
    setInvincible(on) {
        return wrap(`
            const p = $gamePlayer;
            if (${on ? 'true' : 'false'}) { p.lockInvincible(); }
            else { p.unlockInvincible(); }
            return JSON.stringify({ ok: true, invincible: !!p.isInvincible() });
        `);
    },

    /**
     * 穿墙（屏蔽碰撞检测）。
     *
     * ⚠️ 关闭穿墙时必须清一次残留碰撞：穿墙期间碰撞检测整个被跳过
     * （nya_physics.js:744 直接 return），`_impact` 不会被自动清理。
     * 如果残留的是 type===2 的致命地形，恢复碰撞后 isFallDown() 会立刻为 true，
     * 角色会被坠落复位弹走。这里顺手清掉。
     */
    setNoclip(on) {
        return wrap(`
            ${SAFE_CHAR}
            const p = $gamePlayer;
            for (const c of [p, lilyAny()]) {
                if (!c) continue;
                safeChar(c);
                if (${on ? 'true' : 'false'}) c.suspendPhysicsHitTest();
                else c.resumePhysicsHitTest();
            }
            return JSON.stringify({ok:true,noclip:!!p._suspendPhysicsHitTest});
        `);
    },

    /**
     * 一键还原所有作弊状态 —— 断开连接前、或工具出错后用它兜底。
     * 同样要清残留碰撞，理由见 setNoclip 的注释。
     */
    restoreAll() {
        return wrap(`
            ${SAFE_CHAR}
            const p = $gamePlayer;
            const lh = lilyAny();
            if (window.__nyaruruPhoto) window.__nyaruruPhoto.unpinAll();
            if (window.__nyaruruTrainer) window.__nyaruruTrainer.clear();
            // 玩家和莉莉娅都要清 —— 只清玩家的话，同伴会继续坠落复位循环
            for (const c of [p, lh]) {
                if (!c) continue;
                safeChar(c);
                try { c.resumeGravity(); c.resumeFriction(); } catch (e) {}
                try { c.unlockInvincible(); } catch (e) {}
                try { c.resumePhysicsHitTest(); } catch (e) {}
            }
            return JSON.stringify({
                ok: true, gravity: !p.isSuspendGravity(),
                noclip: !!p._suspendPhysicsHitTest,
                invincible: !!p.isInvincible(),
                lilyTouched: !!lh,
            });
        `);
    },

    /**
     * 列出当前地图上的所有事件（用于"从事件列表选点"传送）。
     *
     * 光返回 `EV058` 这种内部编号对用户毫无意义（和"地图170"一个毛病），
     * 所以这里多挖两样东西交给服务端加工：
     *
     *   storyIds —— 从事件页的 `call_story` 插件指令里读出的故事序号。
     *               指令参数结构实测为：
     *               ["NYA.ACHIEVES_Adapter", "call_story", "调用故事序列", {"id":"92"}]
     *               服务端拿它去查台词，把事件变成「台词」— 说话人
     *
     *   sprite   —— 事件用的角色图名，能说明这是什么东西。
     *               实测有 ;moving_platform_upper（移动平台）、
     *               ;cat_coin_copper（铜币）这类可读的名字。
     *
     *   当前页触发类型（trigger）说明它是怎么被触发的：按确定键 / 玩家接触 / 自动执行…
     */
    listEvents() {
        return wrap(`
            const m = $gameMap;
            const TRIG = { 0: '按确定键', 1: '玩家接触', 2: '事件接触', 3: '自动执行', 4: '并行' };
            const list = [];

            for (const ev of m.events()) {
                if (!ev) continue;
                const data = ev.event();
                const storyIds = [];

                if (data && data.pages) {
                    for (const page of data.pages) {
                        for (const c of (page.list || [])) {
                            if (c.code !== 357) continue;                 // 357 = 插件指令
                            const p = c.parameters || [];
                            if (p[1] !== 'call_story') continue;
                            // 故事序号在最后一个参数的 id 字段里
                            const arg = p[p.length - 1];
                            if (arg && arg.id !== undefined) {
                                const n = Number(arg.id);
                                if (!Number.isNaN(n)) storyIds.push(n);
                            }
                        }
                    }
                }

                let sprite = '';
                try { sprite = ev.characterName ? ev.characterName() : ''; } catch (e) {}

                // 事件还没被激活时 _trigger 是 null（_pageIndex 为 -1），
                // 这时退回读第一页的 trigger，避免显示成 "null"
                let trigCode = ev._trigger;
                if (trigCode === null || trigCode === undefined) {
                    const firstPage = data && data.pages && data.pages.find(p => p);
                    trigCode = firstPage ? firstPage.trigger : null;
                }

                list.push({
                    id: ev.eventId(),
                    name: data ? data.name : '(无名)',
                    x: ev._x, y: ev._y,
                    trigger: TRIG[trigCode] !== undefined ? TRIG[trigCode] : (trigCode === null ? '未激活' : String(trigCode)),
                    sprite: String(sprite || '').replace(/^;/, ''),
                    storyIds: [...new Set(storyIds)],
                    // 被游戏自己抹除的事件（开发文档第 6 节）：页号钉死在 -1，
                    // 走过去也触发不了，开关怎么补都没用 —— 只能走"运行过场"
                    erased: !!ev._erased,
                    pageIndex: ev._pageIndex,
                });
            }
            return JSON.stringify({ ok: true, events: list, mapId: m.mapId() });
        `);
    },
};

module.exports = { OPS, wrap };
