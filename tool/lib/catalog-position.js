// Pure geometry helpers plus an adapter evaluated inside the game.
function catalogCellBounds(data, thumbnail, cell) {
    if (!data || !thumbnail || !cell || !thumbnail.data?.some(p=>p.x===cell.x&&p.y===cell.y)) throw Error('这个地点缺少可核实的小地图分块信息，未执行传送');
    const columns=thumbnail.maxX-thumbnail.minX+1,rows=thumbnail.maxY-thumbnail.minY+1;
    const ox=Number(data.meta?.cellOx)||0,oy=Number(data.meta?.cellOy)||0;
    const width=data.width/columns,height=data.height/rows;
    const left=Math.max(0,(cell.x-thumbnail.minX)*width-ox),top=Math.max(0,(cell.y-thumbnail.minY)*height-oy);
    const right=Math.min(data.width,(cell.x-thumbnail.minX+1)*width-ox),bottom=Math.min(data.height,(cell.y-thumbnail.minY+1)*height-oy);
    if(![left,top,right,bottom].every(Number.isFinite)||right<=left||bottom<=top)throw Error('小地图分块范围无效，未执行传送');
    return{left,top,right,bottom,cellX:cell.x,cellY:cell.y};
}

function findCatalogLanding({bounds,shape,tileWidth:tw,tileHeight:th,hitsAt,maxProbes=14000}) {
    const minX=Math.ceil(bounds.left*tw+shape.left+8),maxX=Math.floor(bounds.right*tw-shape.right-8);
    const minY=Math.ceil(bounds.top*th+shape.top+8),maxY=Math.floor(bounds.bottom*th-shape.bottom-8);
    if(minX>maxX||minY>maxY)return null;
    const axis=(min,max,step)=>{const out=[min];for(let v=min+step;v<max;v+=step)out.push(v);if(max!==min)out.push(max);return out;};
    const candidates=[];
    for(const px of axis(minX,maxX,tw/2))for(const py of axis(minY,maxY,th/2))candidates.push({px,py,edge:Math.min((px-minX)/tw,(maxX-px)/tw,(py-minY)/th,(maxY-py)/th)});
    candidates.sort((a,b)=>a.edge-b.edge||b.py-a.py||a.px-b.px);
    let probes=0,floating=null;
    const budgetError=Error('分块落点检查达到上限');
    const hit=(px,py)=>{if(++probes>maxProbes)throw budgetError;return hitsAt(px,py)||[];};
    const hazard=o=>o.type===2||!!o.triggerDamage||Number(o.upElastic)>0;
    try{
    for(const candidate of candidates){
        const{px,py}=candidate;
        if(hit(px,py).length)continue;
        let supported=null,danger=false;
        for(let d=1;d<=Math.min(2*th,maxY-py);d+=Math.max(1,th/8)){
            const hits=hit(px,py+d);
            if(!hits.length)continue;
            danger=hits.some(hazard)||hits.some(o=>!o.terrain&&!o.fix);
            if(!danger&&hits.some(o=>o.terrain||o.fix)){
                let low=0,high=d;
                while(high-low>1){const mid=Math.floor((low+high)/2);if(hit(px,py+mid).length)high=mid;else low=mid;}
                supported={px,py:py+low,grounded:true};
            }
            break;
        }
        if(supported)return{...supported,probes};
        if(!danger&&!floating)floating={px,py,grounded:false};
    }
    }catch(error){if(error!==budgetError||!floating)throw error;}
    return floating?{...floating,probes}:null;
}

function planCatalogLanding(mapId,target,live=false) {
    const data=DataManager.getCachedData(mapId);
    const thumbnail=DataManager.getThumbnailMapInfo(mapId);
    let cell;
    if(target && typeof target==='object') {
        if(![target.cellX,target.cellY,target.page].every(Number.isInteger))throw Error('地图分块坐标无效');
        cell=Object.values(DataManager._thumbnailMapCell||{}).find(c=>c.mapId===mapId&&c.x===target.cellX&&c.y===target.cellY&&c.page===target.page);
        if(!cell)throw Error('目标分块不属于指定地图或页面，未执行传送');
        catalogCellBounds(data,thumbnail,cell);
    } else {
        const event=data?.events?.[target];
        if(!event)throw Error('收集来源事件不存在，请刷新百科');
        cell=DataManager.getThumbnailCell(event.x,event.y,mapId);
    }
    let targetBounds=null;
    if(cell?.mapId===mapId)try{targetBounds=catalogCellBounds(data,thumbnail,cell);}catch{}
    const current=mapId===$gameMap.mapId();
    if(live&&!current)throw Error('目标地图尚未载入');
    let terrain;
    if(current)terrain=$gameMap._terrain;
    else{
        const preview=Object.create(Game_Map.prototype);
        Object.assign(preview,{_mapId:mapId,_tmxExternalVertices:{},_terrain:new PhysicsGrid()});
        // No setup(), events, scene loading, or swaps of the real $gameMap/$dataMap.
        preview.tilemapTerrain();preview._terrain.rebuild();terrain=preview._terrain;
    }
    if(!terrain)throw Error('目标地图碰撞资料尚未就绪，未执行传送');
    const tw=$gameMap.tileWidth(),th=$gameMap.tileHeight(),characters=[$gamePlayer];
    if(typeof $gameLily!=='undefined'&&$gameLily&&!$gameLily.isRemove())characters.push($gameLily);
    const shape={left:Math.max(...characters.map(p=>p.hitOffsetL()))+4,right:Math.max(...characters.map(p=>p.hitOffsetR()))+4,
        top:Math.max(th*0.8,...characters.map(p=>p.hitOffsetT()))+4,bottom:Math.max(...characters.map(p=>p.hitOffsetB()))+4};
    const probe=new Game_CharacterBase();
    Object.assign(probe,{_hitOffsetL:shape.left,_hitOffsetR:shape.right,_hitOffsetT:shape.top,_hitOffsetB:shape.bottom,
        _direction:6,_invertMode:false,_physicsFlag:0,_isFastRect:true,vertices:null});
    probe.hitTest=function(other){return !characters.includes(other)&&this.baseHitTest(other);};
    const grids=[terrain];
    if(current)grids.push($gameMap._physicsFixGrid,$gameMap._physicsDynamicGrid);
    const hitsAt=(px,py)=>{
        probe.px=probe.rx=px;probe.py=probe.ry=py;
        const hits=[];for(const grid of grids)grid?.getObjGrid(probe,hits);return hits;
    };
    const areas=targetBounds?[targetBounds]:[];
    const otherCells=[...(thumbnail?.data||[])].filter(p=>!cell||p.x!==cell.x||p.y!==cell.y)
        .sort((a,b)=>Math.abs(a.x-(cell?.x||0))+Math.abs(a.y-(cell?.y||0))-Math.abs(b.x-(cell?.x||0))-Math.abs(b.y-(cell?.y||0)));
    for(const p of otherCells)try{areas.push(catalogCellBounds(data,thumbnail,p));}catch{}
    areas.push({left:0,top:0,right:data.width,bottom:data.height,cellX:null,cellY:null});
    for(const bounds of areas){
        let result;
        try{result=findCatalogLanding({bounds,shape,tileWidth:tw,tileHeight:th,hitsAt});}
        catch(error){if(!error.message.includes('检查达到上限'))throw error;}
        if(!result)continue;
        const alternate=bounds!==targetBounds;
        return{...result,bounds,targetBounds,alternate,x:(result.px-$gamePlayer.tileXToCenterX(0))/tw,y:(result.py-$gamePlayer.tileYToCenterY(0))/th,
            positionNote:alternate?'目标分块受阻，已改到同图其他可用位置':result.grounded?'目标分块边缘附近的可落脚空处':'目标分块内的空处，保持悬停'};
    }
    // Only an entirely blocked/unavailable map fails; a blocked target cell alone
    // always expands the search instead of cancelling the user's journey.
    throw Error('已检查目标分块、邻近分块和整张地图，仍未找到能容纳角色的空处');
}

module.exports={catalogCellBounds,findCatalogLanding,planCatalogLanding};
