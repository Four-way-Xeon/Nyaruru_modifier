// 此函数在游戏上下文中运行。记录留在 window 的非枚举属性中，不进入存档。
function installPhotoTools() {
    if (window.__nyaruruPhoto) { window.__nyaruruPhoto.touch?.(); return window.__nyaruruPhoto; }
    const records = new Map();
    let lastTouch = Date.now();
    const refreshSprite = ev => {
        const walk = node => {
            if (!node) return;
            if (node._character === ev && node.setCharacterBitmap) {
                node._characterName = ev.bitmapName ? ev.bitmapName() : ev.characterName();
                node._characterIndex = ev.characterIndex();
                node._tileId = ev.tileId();
                if (node._tileId) node.setTileBitmap(); else node.setCharacterBitmap();
                // 换位图会重置为整张图；角色帧号即使没变，也必须重新裁切。
                // 图片异步加载完成时还会重置一次，因此在加载回调中刷新游戏自己的帧逻辑。
                const bitmap = node._contentSprite ? node._contentSprite.bitmap : node.bitmap;
                const refreshFrame = () => {
                    const current = node._contentSprite ? node._contentSprite.bitmap : node.bitmap;
                    if (node._character !== ev || current !== bitmap) return;
                    node._framePos = -1;
                    if (node.updateFrame) node.updateFrame();
                };
                node._framePos = -1;
                if (bitmap && bitmap.addLoadListener) bitmap.addLoadListener(refreshFrame);
                else refreshFrame();
            }
            for (const child of node.children || []) walk(child);
        };
        try { walk(SceneManager._scene); } catch { /* 精灵尚未建立时由下一帧刷新 */ }
    };
    const settle = (ev, page) => {
        const ai = ev.event?.().pages?.[page]?.list?.find(c => c.code === 357 && c.parameters?.[1] === 'ai')?.parameters?.[3];
        // 只有原页明确要求贴地的角色参与；飞行角色、固定摆件及无近处地面保持原位。
        if (String(ai?.smoothfloor) !== 'true' || String(ai?.skipSmoothfloor) === 'true' || String(ai?.fix) === 'true' || !ev.hitPreview || !ev.locate) return;
        const th = $gameMap.tileHeight(), tw = $gameMap.tileWidth();
        for (let dy = 0; dy <= th; dy++) {
            const hits = (ev.hitPreview(0, dy) || []).filter(o => o?.terrain === true);
            if (!hits.length) continue;
            if (hits.some(o => o.type === 2)) return;
            const drop = Math.max(0, dy - 1); // 停在地形外侧，不能把碰撞体塞进地板。
            if (!drop) return;
            const x = ev.tileXToCenterX ? (ev.px - ev.tileXToCenterX(0)) / tw : (ev._realX ?? ev._x);
            const y = ev.tileYToCenterY ? (ev.py + drop - ev.tileYToCenterY(0)) / th : (ev._realY ?? ev._y) + drop / th;
            ev.locate(x, y);
            ev.clearImpact?.(); ev.clearGrounding?.();
            ev._groundingX = ev._terrainGroundingX = ev.px;
            ev._groundingY = ev._terrainGroundingY = ev.py;
            return;
        }
    };
    const unpin = ev => {
        const record = records.get(ev);
        if (!record) return;
        // 还原被我们覆盖的自有字段和方法，包括原始 _erased、解释器及物理状态。
        for (const key of Reflect.ownKeys(ev)) if (!Object.hasOwn(record, key)) delete ev[key];
        Object.defineProperties(ev, record);
        records.delete(ev);
        refreshSprite(ev);
    };
    const api = {
        touch: () => { lastTouch = Date.now(); },
        count: () => records.size,
        facePlayer(ev) {
            if (!records.has(ev) || typeof $gamePlayer === 'undefined' || !ev.setDirection) return;
            const dx = $gamePlayer.px - ev.px;
            if (!Number.isFinite(dx) || Math.abs(dx) < 1) return;
            const fixed = ev._directionFix;
            try { ev._directionFix = false; ev.setDirection(dx < 0 ? 4 : 6); }
            finally { ev._directionFix = fixed; }
        },
        unpinAll() {
            const n = records.size;
            for (const ev of [...records.keys()]) unpin(ev);
            if ($gameMap?.requestRefresh) $gameMap.requestRefresh();
            return n;
        },
        pin(ev, page) {
            if (records.has(ev)) unpin(ev);
            const record = Object.getOwnPropertyDescriptors(ev);
            records.set(ev, record);
            try {
                // setupPageSettings 会写 statemMembers，隔离这层避免污染撤销快照。
                if (ev._statemMembers) ev._statemMembers = { ...ev._statemMembers };
                ev._erased = false;
                ev._pageIndex = page;
                ev.setupPageSettings();
                settle(ev, page);
                for (const name of ['start', 'update', 'updateParallel', 'checkEventTriggerAuto', 'checkEventTriggerTouch', 'physicsTriggerTouch', 'refresh']) {
                    Object.defineProperty(ev, name, { value() {}, configurable: true, writable: true });
                }
                // 只更新图片帧，不调用 Game_Event.update（其中包含 AI、移动和事件触发）。
                Object.defineProperty(ev, 'update', { configurable: true, writable: true, value() {
                    if (typeof ImageFrame !== 'undefined' && this.updateFrameAnimation) {
                        this.updateFrameAnimation(ImageFrame.info(this.characterName()));
                    }
                } });
                Object.defineProperty(ev, 'findProperPageIndex', { value: () => page, configurable: true, writable: true });
                ev._starting = false; ev._trigger = null; ev._interpreter = null; ev._moveType = 0;
                ev.physics = false; ev.fix = true;
                ev.vx = ev.vy = ev._vx = ev._vy = 0;
                api.facePlayer(ev);
                refreshSprite(ev);
            } catch (e) { unpin(ev); throw e; }
        },
    };
    Object.defineProperty(window, '__nyaruruPhoto', { value: api, configurable: true });
    // 面板关闭或断线后两分钟撤销摆拍，恢复事件原有行为。
    if (typeof setInterval === 'function') setInterval(() => {
        if (records.size && Date.now() - lastTouch > 120000) api.unpinAll();
    }, 10000);
    // 不拦截游戏的手动或自动存档；摆拍跨读档的限制由面板提示。
    // 正常切图或读档会结束摆拍，清除旧地图的记录。
    for (const [object, name] of [[Game_Map.prototype, 'setup'], [DataManager, 'extractSaveContents']]) {
        const original = object[name];
        if (typeof original !== 'function') continue;
        object[name] = function(...args) { api.unpinAll(); return original.apply(this, args); };
    }
    return api;
}
module.exports = { installPhotoTools };
