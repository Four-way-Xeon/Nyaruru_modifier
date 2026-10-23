// Evaluated in the game: read original schematic cells, never activate exploration.
function readWorldMap(encyclopedia) {
    const source = Object.values(DataManager._thumbnailMapCell || {});
    if (!source.length) throw Error('世界地图资料尚未加载，请先正常读档');
    const keyOf = c => `${c.page}:${c.x}:${c.y}`;
    const cells = source.map(c => ({ key: keyOf(c), page: c.page, regionId: c.regionId, mapId: c.mapId,
        x: c.x, y: c.y, hidden: !!c.hidden,
        mapName: $dataMapInfos?.[c.mapId]?.name || '地图 ' + c.mapId,
        explored: !!$gameSystem.isThumbnailActive(DataManager.makePosKey(c.x,c.y)),
        walls: { left:!!c.l, top:!!c.t, right:!!c.r, bottom:!!c.b },
        exits: { left:!!c.pl, top:!!c.pt, right:!!c.pr, bottom:!!c.pb } }));
    const byCell = new Map(cells.map(c => [c.key,c]));
    const definitions = new Map(encyclopedia.items.map(i => [i.type + ':' + i.id,i]));
    const markers = [], unmapped = [];
    for (const location of encyclopedia.locations) {
        const c = DataManager.getThumbnailCell(location.x,location.y,location.mapId);
        const cell = c && byCell.get(keyOf(c));
        if (!cell || cell.mapId !== location.mapId) { unmapped.push(location.key); continue; }
        const iconKey = location.type + ':' + location.id, item = definitions.get(iconKey);
        markers.push({ ...location, cellKey:cell.key, page:cell.page, regionId:cell.regionId,
            name:item?.name || iconKey, desc:item?.desc || '', iconKey });
    }
    const official = new Set();
    for (const region of Object.values($dataRegion || {}))
        for (const [mapId,eventId] of region?.exploreItem || []) official.add(mapId + ':' + eventId);
    const mapped = new Set(markers.filter(m=>m.official).map(m=>m.mapId + ':' + m.eventId));
    const regions = [...new Set(cells.map(c=>c.regionId))].sort((a,b)=>a-b).map(id=>({id,
        name:$dataRegion?.[id]?.name || '区域 ' + id,
        color:'#' + (DataManager.regionColor?.(id) || 0).toString(16).padStart(6,'0')}));
    const pages = [...new Set(cells.map(c=>c.page))].sort((a,b)=>a-b).map(id=>{
        const group=cells.filter(c=>c.page===id);
        return {id,label:'页面 ' + id,regionIds:[...new Set(group.map(c=>c.regionId))],
            minX:Math.min(...group.map(c=>c.x)),maxX:Math.max(...group.map(c=>c.x)),
            minY:Math.min(...group.map(c=>c.y)),maxY:Math.max(...group.map(c=>c.y))};
    });
    const current=DataManager.getCurrentThumbnailCell();
    const playerCell=current && byCell.get(keyOf(current));
    const player=playerCell ? {cellKey:playerCell.key,page:playerCell.page,regionId:playerCell.regionId,
        mapId:$gameMap.mapId(),x:$gamePlayer._x,y:$gamePlayer._y} : {cellKey:null,mapId:$gameMap.mapId()};
    const missing=[...official].filter(k=>!mapped.has(k)), mappedOfficial=official.size-missing.length;
    return {ok:true,regions,pages,cells,markers,player,coverage:{cells:cells.length,markers:markers.length,
        officialTotal:official.size,mappedOfficial,officialMapped:mappedOfficial,missing,missingOfficial:missing,unmapped,
        message:`原版收集点已映射 ${mappedOfficial}/${official.size}；地图 ${cells.length} 格`}};
}
module.exports={readWorldMap};
