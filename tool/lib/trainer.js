// Injected into the game. Uses NYA's actor inventory/battle values, not RPG Maker HP/gold.
function installTrainer() {
    if (window.__nyaruruTrainer) return window.__nyaruruTrainer;
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
    setInterval(() => { try { sync(); } catch { clear(); } }, 100);

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
        return { ok: true, subject, role: $gamePlayer.isLilyMode() ? '莉莉娅' : actor.name(), stats, items };
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
        } else if (body.action === 'item') {
            const { type } = body;
            const itemId = integer(body.id, 99999);
            if (Object.prototype.hasOwnProperty.call(specials, type)) {
                if (itemId !== 0) throw new Error('物品编号无效');
                actor[specials[type][2]] = integer(body.count, 99999);
            } else {
                if (!categories.includes(type)) throw new Error('物品分类无效');
                const container = actor['_' + type], data = container.data();
                if (!Object.prototype.hasOwnProperty.call(data, itemId) || !data[itemId]) throw new Error('物品不存在');
                const max = type === 'consumables' ? (body.overCap === true ? 99999 : container.maxNum(itemId)) : 1;
                const count = integer(body.count, max);
                if (type === 'consumables') container.add(itemId, count - container.itemNum(itemId), body.overCap === true);
                else if (count) container.unlock(itemId);
                else if (type === 'weapons') {
                    const remaining = container._unlock.filter(n => n !== itemId);
                    if (!remaining.length) throw new Error('至少需要保留一件武器，避免游戏攻击时找不到武器');
                    if (container.currentWeapon() === itemId) { actor.changeWeapon(remaining[0]); $gamePlayer.setWeaponChange(); }
                    container._unlock = remaining;
                } else if (type === 'ornaments') container.remove(itemId);
                else {
                    if (container.isEquip(itemId)) container.equip(itemId);
                    container._unlock = container._unlock.filter(n => n !== itemId);
                }
            }
        } else throw new Error('未知修改操作');
        return read();
    }
    return window.__nyaruruTrainer = { read, change, touch, clear };
}

module.exports = { installTrainer };
