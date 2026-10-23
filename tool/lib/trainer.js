// Injected into the game. Uses NYA's actor inventory/battle values, not RPG Maker HP/gold.
function installTrainer() {
    if (window.__nyaruruTrainer?.version === 3) return window.__nyaruruTrainer;
    if (window.__nyaruruTrainer?.dispose) window.__nyaruruTrainer.dispose();
    else window.__nyaruruTrainer?.clear();
    const fields = { coin: '_coin', hp: '_hp', sp: 'sp', zp: 'zp' };
    const locks = new Map();
    const ids = new WeakMap();
    let serial = 0, touched = Date.now(), actors = $gameActors, party = $gameParty;
    const id = o => { if (!ids.has(o)) ids.set(o, ++serial); return ids.get(o); };
    const active = () => {
        const actor = $gamePlayer.actor(), battle = $gamePlayer.battleObject();
        if (!actor || !battle) throw new Error('当前角色数据尚未就绪');
        return { actor, battle, subject: `${id(actor)}:${id(battle)}:${!!$gamePlayer.isLilyMode()}` };
    };
    const maximum = (field, b) => field === 'coin' ? 99999 : Math.max(0, Math.floor(b['m' + field]));
    const integer = (value, max) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
            throw new Error(`请输入 0～${max} 的整数`);
        }
        return value;
    };
    // Accessor intercepts the actual storage slot, so even lethal damage cannot reach zero
    // before a later polling refill. Descriptor flags and the current value survive unlock.
    function detach(lock) {
        if (!lock.object) return;
        const value = lock.value();
        Object.defineProperty(lock.object, fields[lock.field], { ...lock.descriptor, value });
        lock.object = null;
    }
    function clear() {
        for (const lock of locks.values()) detach(lock);
        locks.clear();
    }
    function sync() {
        if (actors !== $gameActors || party !== $gameParty || Date.now() - touched > 120000) {
            clear(); actors = $gameActors; party = $gameParty;
        }
        if (!locks.size) return;
        const { actor, battle } = active();
        for (const lock of locks.values()) {
            const object = lock.field === 'coin' ? actor : battle;
            if (lock.object === object) continue;
            detach(lock);
            const key = fields[lock.field], descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor?.configurable || !descriptor.writable || !('value' in descriptor)) {
                throw new Error('当前游戏的数值结构不支持锁定');
            }
            lock.object = object; lock.descriptor = descriptor;
            lock.value = () => Math.min(lock.target, maximum(lock.field, battle));
            Object.defineProperty(object, key, {
                configurable: true, enumerable: descriptor.enumerable,
                get: () => lock.value(), set: () => {},
            });
        }
    }
    function touch() { sync(); touched = Date.now(); }
    // Only one timer per game page; neither hooks nor lock settings enter save data.
    const timer = setInterval(() => { try { sync(); } catch { clear(); } }, 100);

    const categories = ['consumables', 'weapons', 'stones', 'ornaments'];
    const specials = {
        joycoin: ['joyCoinData', 'joyCoinNum', '_joyCoin'],
        hpst: ['hpStrengthData', 'hpStrengthNum', '_hpStrengthItem'],
        skillst: ['skillStrengthData', 'skillStrengthNum', '_skillStrengthItem'],
    };
    const localized = key => String(TextManager[key] ?? key ?? '');
    function read() {
        touch();
        const { actor, battle, subject } = active();
        const stats = Object.fromEntries(Object.keys(fields).map(field => [field, {
            value: field === 'coin' ? actor.coin() : battle[field],
            max: maximum(field, battle), locked: locks.has(field), target: locks.get(field)?.target ?? null,
        }]));
        const items = [];
        for (const type of categories) {
            const container = actor['_' + type];
            for (const [key, data] of Object.entries(container.data())) {
                const itemId = Number(key);
                if (!Number.isSafeInteger(itemId) || itemId < 0 || !data) continue;
                items.push({ type, id: itemId, name: localized(data.name), desc: localized(data.desc),
                    count: type === 'consumables' ? container.itemNum(itemId) : Number(container.isUnlock(itemId)),
                    max: type === 'consumables' ? container.maxNum(itemId) : 1,
                    equipped: type === 'weapons' ? container.currentWeapon() === itemId : !!container.isEquip?.(itemId),
                });
            }
        }
        for (const [type, [dataMethod, countMethod]] of Object.entries(specials)) {
            const data = actor[dataMethod]();
            items.push({ type, id: 0, name: localized(data.name), desc: localized(data.desc), count: actor[countMethod](), max: 99999, equipped: false });
        }
        if (actor._ornaments.bellData) {
            const data = actor._ornaments.bellData(), fromMap = actor._ornaments.eventBellGainNum();
            items.push({ type: 'bell', id: 0, name: localized(data.name), desc: localized(data.desc) + ' 默认保留地图铃铛；允许重置收集点时可减少到 0。',
                count: actor.bellNum(), min: fromMap, max: 25, equipped: false });
        }
        const capacity = actor._ornaments.maxEquip ? { used: actor._ornaments.hasEquipNum(), max: actor._ornaments.maxEquip(),
            mapBells: actor._ornaments.eventBellGainNum(), extraBells: actor._ornaments._hasBuyBellNum } : null;
        return { ok: true, subject, role: $gamePlayer.isLilyMode() ? '莉莉娅' : actor.name(), stats, items, capacity };
    }
    function validateItem(actor, body) {
        const { type } = body, itemId = integer(body.id, 99999);
        if (type === 'bell') {
            if (itemId !== 0 || !actor._ornaments.bellData) throw new Error('铃铛数据不可用');
            const count = integer(body.count, 25), minimum = actor._ornaments.eventBellGainNum();
            if (count < minimum) {
                if (body.adjustMapBells !== true) throw new Error(`已从地图取得 ${minimum} 个铃铛；勾选允许重置地图铃铛后可继续减少`);
                const keys = typeof DataManager !== 'undefined' && DataManager._cacheBell;
                if (!Array.isArray(keys) || keys.filter(key => $gameSelfSwitches.value(key)).length !== minimum) throw new Error('地图铃铛记录不完整，不能减少');
            }
            return;
        }
        if (Object.prototype.hasOwnProperty.call(specials, type)) {
            if (itemId !== 0) throw new Error('物品编号无效');
            integer(body.count, 99999); return;
        }
        if (!categories.includes(type)) throw new Error('物品分类无效');
        const container = actor['_' + type], data = container.data();
        if (!Object.prototype.hasOwnProperty.call(data, itemId) || !data[itemId]) throw new Error('物品不存在');
        integer(body.count, type === 'consumables' ? (body.overCap === true ? 99999 : container.maxNum(itemId)) : 1);
    }
    function applyItem(actor, body) {
        const { type, id: itemId, count } = body;
        if (type === 'bell') {
            const o = actor._ornaments;
            if (count < o.eventBellGainNum()) {
                const acquired = DataManager._cacheBell.filter(key => $gameSelfSwitches.value(key));
                // Remove the highest map/event keys first for deterministic results.
                const ordered = [...acquired].sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
                for (const key of ordered.slice(count)) $gameSelfSwitches.setValue(key, false);
            }
            o._hasBuyBellNum = count - o.eventBellGainNum();
            while (o.hasEquipNum() > o.maxEquip()) {
                const removable = [...o._equip].reverse().find(id => id !== 20);
                if (removable === undefined) break;
                o.unequip(removable);
            }
        } else if (Object.prototype.hasOwnProperty.call(specials, type)) actor[specials[type][2]] = count;
        else {
            const container = actor['_' + type];
            if (type === 'consumables') container.add(itemId, count - container.itemNum(itemId), body.overCap === true);
            else if (count) container.unlock(itemId);
            else if (type === 'weapons') {
                const remaining = container._unlock.filter(n => n !== itemId);
                if (container.currentWeapon() === itemId) { actor.changeWeapon(remaining[0]); $gamePlayer.setWeaponChange(); }
                container._unlock = remaining;
            } else if (type === 'ornaments') container.remove(itemId);
            else {
                if (container.isEquip(itemId)) container.equip(itemId);
                container._unlock = container._unlock.filter(n => n !== itemId);
            }
        }
    }
    function change(body) {
        touch();
        const { actor, battle, subject } = active();
        if (body.subject !== subject) throw new Error('操作角色已变化，请刷新角色与背包后重试');
        if (body.action === 'stat') {
            const field = body.field;
            if (!Object.prototype.hasOwnProperty.call(fields, field)) throw new Error('未知数值');
            if (body.locked !== undefined && typeof body.locked !== 'boolean') throw new Error('锁定参数无效');
            if (body.locked === false) {
                const old = locks.get(field);
                if (old) { detach(old); locks.delete(field); }
                return read();
            }
            const value = integer(body.value, maximum(field, battle));
            if (field === 'hp' && battle.hp === 0 && value > 0) throw new Error('角色已倒下，请先在游戏里复活或读档，再修改血量');
            const old = locks.get(field), keepLocked = body.locked === true || !!old;
            if (old) { detach(old); locks.delete(field); }
            if (field === 'coin') {
                const delta = value - actor.coin();
                if (delta >= 0) actor.addCoin(delta); else actor.deductCoin(-delta);
            } else battle['add' + field[0].toUpperCase() + field.slice(1)](value - battle[field]);
            if (keepLocked) {
                locks.set(field, { field, target: value, object: null });
                try { sync(); } catch (e) { clear(); throw e; }
            }
        } else if (body.action === 'equip') {
            const { type, id: itemId } = body;
            if (!['weapons','stones','ornaments'].includes(type) || typeof body.equipped !== 'boolean') throw new Error('装备参数无效');
            integer(itemId, 99999);
            const container = actor['_' + type];
            if (!Object.hasOwn(container.data(), itemId) || !container.isUnlock(itemId)) throw new Error('需要先获得该物品');
            if (type === 'weapons') { if (!body.equipped) throw new Error('当前武器不能卸为空'); actor.changeWeapon(itemId); $gamePlayer.setWeaponChange(); }
            else if (type === 'stones') { if (container.isEquip(itemId) !== body.equipped) container.equip(itemId); }
            else if (!body.equipped) container.unequip(itemId);
            else if (!container.isEquip(itemId) && !container.equip(itemId)) throw new Error('配饰栏位不足，请增加铃铛或先卸下其他配饰');
        } else if (body.action === 'batch' || body.action === 'item') {
            const changes = body.action === 'item' ? [body] : body.changes;
            if (!Array.isArray(changes) || !changes.length || changes.length > 100) throw new Error('批量物品列表无效');
            const seen = new Set();
            for (const item of changes) {
                if (!item || typeof item !== 'object') throw new Error('物品参数无效');
                validateItem(actor, item);
                const key = item.type + ':' + item.id;
                if (seen.has(key)) throw new Error('批量列表含重复物品');
                seen.add(key);
            }
            const weapons = new Set(actor._weapons._unlock);
            for (const item of changes) if (item.type === 'weapons') { if (item.count) weapons.add(item.id); else weapons.delete(item.id); }
            if (!weapons.size) throw new Error('至少需要保留一件武器，避免游戏攻击时找不到武器');
            const objects = categories.map(type => actor['_' + type]);
            const snapshots = objects.map(object => Object.fromEntries(Reflect.ownKeys(object).map(key => {
                const d = Object.getOwnPropertyDescriptor(object, key);
                if ('value' in d && d.value && typeof d.value === 'object') d.value = Array.isArray(d.value) ? [...d.value] : { ...d.value };
                return [key, d];
            })));
            const materialKeys = Object.values(specials).map(v => v[2]);
            const materials = materialKeys.map(key => actor[key]);
            const bellFlags = changes.some(i=>i.type==='bell' && i.adjustMapBells === true) ? DataManager._cacheBell.map(key=>[key,$gameSelfSwitches.value(key)]) : [];
            try {
                const ordered = [...changes].sort((a,b) => Number(b.type === 'weapons' && b.count === 1) - Number(a.type === 'weapons' && a.count === 1));
                for (const item of ordered) applyItem(actor, item);
            } catch (e) {
                for (let i = 0; i < objects.length; i++) {
                    for (const key of Reflect.ownKeys(objects[i])) if (!Object.hasOwn(snapshots[i], key)) delete objects[i][key];
                    Object.defineProperties(objects[i], snapshots[i]);
                }
                materialKeys.forEach((key, i) => { actor[key] = materials[i]; });
                for (const [key,value] of bellFlags) $gameSelfSwitches.setValue(key,value);
                throw e;
            }
        } else throw new Error('未知修改操作');
        return read();
    }
    return window.__nyaruruTrainer = { version: 3, read, change, touch, clear, dispose() { clear(); if (typeof clearInterval === 'function') clearInterval(timer); } };
}

module.exports = { installTrainer };
