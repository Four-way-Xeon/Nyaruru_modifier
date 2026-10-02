// 已核对的剧情落脚点。控制事件的位置不一定是角色演出的位置。
// Map181 EV002 第 5 页将玩家送到 Map182 (11,11)，随后由 EV003 自动执行
// 298/299 -> 305。EV003 本身放在 (0,0)，仅用于控制剧情。
// 此表只有结构坐标，不含台词；发布版可直接共用，无需本地解包数据。
function storyPosition(trigger) {
    const { x, y } = trigger;
    const entries = [
        { map: 182, event: 3, page: 0, stories: [298, 299, 305], from: [0, 0], to: [11, 11] },
        // 原游戏 Map006 EV017 第 1 页的入场位置。
        { map: 9, event: 10, page: 5, stories: [449], from: [0, 0], to: [11, 9] },
        // 原游戏 Map301 EV005 第 1 页的村落入口。
        { map: 296, event: 34, page: 5, stories: [449], from: [4, 0], to: [28, 13] },
        // 原游戏 Map004 EV005 第 5 页的梦境入场位置。
        { map: 254, event: 2, page: 0, stories: [467], from: [0, 0], to: [6, 5] },
    ];
    const entry = entries.find(e => Number(trigger.mapId) === e.map && Number(trigger.eventId) === e.event &&
        trigger.pageIndex !== null && trigger.pageIndex !== undefined && Number(trigger.pageIndex) === e.page &&
        e.stories.includes(Number(trigger.storyId)) &&
        x !== null && y !== null && x !== '' && y !== '' && Number(x) === e.from[0] && Number(y) === e.from[1]);
    if (entry) {
        return { x: entry.to[0], y: entry.to[1], positionNote: `使用原游戏入场位置；剧情控制事件位于 (${entry.from.join(',')})` };
    }
    return { x, y };
}
// 在游戏运行时调用；只读取当前地图与碰撞，不加载/导出台词或解包文件。
function chooseStoryPosition({ map, player, data, eventId, pageIndex, storyId, sameMap, previous, preferred, requested }) {
    const event = data.events?.[eventId];
    const containsStory = page => page.list?.some(c => c.code === 357 && c.parameters?.[1] === 'call_story' && Number(c.parameters[3]?.id) === Number(storyId));
    const page = event?.pages?.[pageIndex] || event?.pages?.find(containsStory);
    const hasBody = pg => !!(pg?.image?.characterName || pg?.image?.tileId || pg?.list?.some(c => c.code === 357 && c.parameters?.[1] === 'ai' && Number(c.parameters[3]?.battleObject) > 0));
    if (!page || ![3, 4].includes(page.trigger) || hasBody(page)) return { ok: true, ...requested, controller: false };
    if (!preferred && (requested.x !== event.x || requested.y !== event.y)) preferred = requested;

    const tw = map.tileWidth(), th = map.tileHeight(), step = Math.max(8, Math.floor(th / 4));
    let probes = 0;
    const floor = (x, y, depth) => {
        x = Math.round(x); y = Math.round(y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= map.width() || y >= map.height()) return null;
        for (let dy = 0; dy <= Math.min(depth * th, (map.height() - y) * th); dy += step) {
            if (++probes > 800) return null;
            const hits = (player.hitPreview((x - player._x) * tw, (y - player._y) * th + dy) || []).filter(o => o?.terrain === true);
            if (!hits.length) continue;
            if (hits.some(o => o.type === 2)) return null;
            return { x, y: y + Math.max(0, Math.floor((dy - step) / th)) };
        }
        return null;
    };
    // 同图已站在正常场景里时，不因点击控制事件而把人重新送到角落。
    let pick = sameMap && previous ? floor(previous.x, previous.y, 1) : null;
    let reason = pick ? '保留当前可落地位置' : '';
    if (!pick && preferred) { pick = floor(preferred.x, preferred.y, 2); if (pick) reason = '使用已核实的入场位置'; }
    const events = (map.events() || []).filter(e => e && e.eventId() !== Number(eventId));
    const refs = new Set((page.list || []).filter(c => [203, 205, 213].includes(c.code)).map(c => Number(c.parameters?.[0])).filter(id => id > 0));
    const ordered = [
        ...events.filter(e => refs.has(e.eventId())),
        ...events.filter(e => e.characterName?.()),
        ...events.filter(e => e.event()?.pages?.some(hasBody)),
    ];
    const seen = new Set();
    for (const ev of ordered) {
        if (pick || probes >= 600) break;
        if (seen.has(ev)) continue;
        seen.add(ev);
        for (const dx of [-1, 1, -2, 2]) {
            pick = floor(ev._x + dx, Math.max(0, ev._y - 1), 4);
            if (pick) { reason = '按场景人物附近的安全地面定位'; break; }
        }
    }
    // 场景人物不可用时，仅在地图内部做有上限的地形扫描，不猜测原作站位。
    if (!pick) {
        const xs = Array.from({ length: Math.min(map.width(), 31) }, (_, i) => Math.round((i + 0.5) * map.width() / Math.min(map.width(), 31)))
            .sort((a, b) => Math.abs(a - map.width() / 2) - Math.abs(b - map.width() / 2));
        for (const x of xs) {
            if (probes >= 800) break;
            pick = floor(x, 0, map.height());
            if (pick) { reason = '按当前地图的安全地面定位'; break; }
        }
    }
    if (!pick) return { ok: false, controller: true, error: '这是无形剧情控制事件，未找到可确认的安全落脚点；已保留悬浮，请手动定位后再运行过场' };
    return { ok: true, ...pick, controller: true, positionNote: reason };
}
module.exports = { storyPosition, chooseStoryPosition };
