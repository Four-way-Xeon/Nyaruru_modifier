// Read-only inventory/location join, evaluated in the game. No progress is modified.
function readEncyclopedia(inventory) {
    const maps = DataManager._cacheMapData;
    if (!maps || !Object.keys(maps).length) throw new Error('地图资料尚未加载，请先正常读档');
    const items = inventory.items.map(item => ({ ...item, locations: [] }));
    items.push({ type: 'coin', id: 0, name: '金币', desc: '可用于商店购买物品。', count: inventory.stats.coin.value, max: 99999, locations: [] });
    const byKey = new Map(items.map(item => [item.type + ':' + item.id, item]));
    const shops = [], locations = [], seen = new Set();
    const collectedKeys = new Set();
    for (const region of Object.values(typeof $dataRegion === 'undefined' ? {} : $dataRegion)) {
        for (const [mapId, eventId] of region?.exploreItem || []) collectedKeys.add(mapId + ':' + eventId);
    }
    const conditions = cond => {
        const result = [];
        for (const n of [1, 2]) if (cond?.['switch' + n + 'Valid']) {
            const id = cond['switch' + n + 'Id'];
            result.push({ label: '开关 ' + ($dataSystem.switches[id] || id), met: !!$gameSwitches.value(id) });
        }
        if (cond?.variableValid) result.push({ label: '变量 ' + ($dataSystem.variables[cond.variableId] || cond.variableId) + ' ≥ ' + cond.variableValue,
            met: $gameVariables.value(cond.variableId) >= cond.variableValue });
        if (cond?.actorValid) result.push({ label: '队伍角色 ' + cond.actorId, met: null });
        if (cond?.itemValid) result.push({ label: '持有道具 ' + cond.itemId, met: null });
        return result;
    };
    for (const [mapKey, map] of Object.entries(maps)) {
        const mapId = Number(mapKey);
        if (!map || !Number.isInteger(mapId)) continue;
        const regionId = DataManager.mapRegion?.(mapId) || 0;
        const region = typeof $dataRegion !== 'undefined' && $dataRegion[regionId];
        const area = region?.name || '未分类区域';
        for (const event of map.events || []) {
            if (!event) continue;
            for (const [pageIndex, page] of (event.pages || []).entries()) {
                const list = page.list || [];
                for (const [commandIndex, command] of list.entries()) {
                    if (command.code !== 357) continue;
                    const [, name, , args = {}] = command.parameters || [];
                    const coinPile = name === 'ai' && Number(args.type) === 60;
                    if (!coinPile && !['addItem', 'add_coin', 'shop'].includes(name)) continue;
                    if (name === 'add_coin' && !(Number(args.num) > 0)) continue;
                    const base = { mapId, mapName: $dataMapInfos?.[mapId]?.name || '地图 ' + mapId, area, regionId,
                        eventId: event.id, eventName: event.name || '', x: event.x, y: event.y, pageIndex,
                        conditions: conditions(page.conditions), branch: Number(command.indent) > 0 };
                    if (page.conditions?.selfSwitchValid) base.conditions.push({ label: '独立开关 ' + page.conditions.selfSwitchCh,
                        met: !!$gameSelfSwitches.value([mapId, event.id, page.conditions.selfSwitchCh]) });
                    if (name === 'shop') { shops.push({ ...base, kind: 'shop' }); continue; }
                    const type = name === 'add_coin' || coinPile ? 'coin' : args.type;
                    const id = name === 'add_coin' || coinPile ? 0 : Number(args.idx);
                    const item = byKey.get(type + ':' + id);
                    if (!item) continue;
                    const key = `${type}:${id}:${mapId}:${event.id}:${pageIndex}:${commandIndex}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const official = collectedKeys.has(mapId + ':' + event.id);
                    // A later marker is reliable only for a straight-line pickup. Branch
                    // rewards may reuse A for another path, so those remain unknown.
                    const marker = list.slice(commandIndex + 1).find(c => c.code === 123 && Number(c.indent || 0) === Number(command.indent || 0) && c.parameters?.[1] === 0);
                    const nextPageHides = (event.pages || []).some(pg => pg.conditions?.selfSwitchValid && pg.conditions.selfSwitchCh === marker?.parameters?.[0]);
                    const reliable = official || (!base.branch && marker && nextPageHides);
                    const status = reliable ? !!$gameSelfSwitches.value([mapId, event.id, official ? 'A' : marker.parameters[0]]) : null;
                    const location = { ...base, key, type, id, kind: coinPile ? 'coinpile' : 'pickup', collected: status, official,
                        sourceNote: coinPile ? '猫币堆：击打 8 次耗尽，掉落数量受配饰影响' : '',
                        amount: coinPile ? null : name === 'add_coin' ? Number(args.num) : 1, antiCollection: args.antiCollection === 'true' };
                    item.locations.push(location); locations.push(location);
                }
            }
        }
    }
    const actor = $gamePlayer.actor();
    for (const item of items) {
        let definition = null;
        if (['consumables','weapons','stones','ornaments'].includes(item.type)) definition = actor['_' + item.type].data()[item.id];
        else if (item.type === 'bell') definition = actor._ornaments.bellData();
        else if (item.type === 'hpst') definition = actor.hpStrengthData();
        else if (item.type === 'skillst') definition = actor.skillStrengthData();
        else if (item.type === 'joycoin') definition = actor.joyCoinData();
        item.price = definition?.price ?? null;
        item.shopCandidate = Number(definition?.price) > 0;
        item.openTask = definition?.openTask ?? null;
    }
    const counted = new Map();
    for (const location of locations) if (location.official) counted.set(location.mapId + ':' + location.eventId, location);
    const summaries = new Map();
    for (const location of counted.values()) {
        if (!summaries.has(location.area)) summaries.set(location.area, { area: location.area, total: 0, collected: 0 });
        const s = summaries.get(location.area); s.total++; if (location.collected) s.collected++;
    }
    const regions = [...summaries.values()];
    return { ok: true, items, locations, shops, regions, subject: inventory.subject,
        stats: { items: items.length, locations: locations.length, shops: shops.length,
            total: counted.size, collected: [...counted.values()].filter(l => l.collected).length },
        coverage: '来源为当前游戏已加载的地图物品指令、猫币堆、收集点和商店入口。商店候选需结合任务进度在店内确认；脚本动态奖励及普通敌人掉落不在地图索引中。未知状态不会按未收集处理。' };
}
module.exports = { readEncyclopedia };
