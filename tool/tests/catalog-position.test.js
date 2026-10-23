const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {catalogCellBounds,findCatalogLanding}=require('../lib/catalog-position');
const {OPS}=require('../lib/ops');

test('catalog cell bounds use the actual submap cell and coordinate offsets',()=>{
    const thumbnail={minX:35,maxX:35,minY:32,maxY:35,data:[{x:35,y:32},{x:35,y:33},{x:35,y:34},{x:35,y:35}]};
    assert.deepEqual(catalogCellBounds({width:20,height:64,meta:{}},thumbnail,{x:35,y:34}),{left:0,top:32,right:20,bottom:48,cellX:35,cellY:34});
    assert.deepEqual(catalogCellBounds({width:20,height:64,meta:{cellOx:2,cellOy:3}},thumbnail,{x:35,y:34}),{left:0,top:29,right:18,bottom:45,cellX:35,cellY:34});
    assert.throws(()=>catalogCellBounds({},thumbnail,{x:99,y:99}),/分块信息/);
});

test('catalog landing checks the whole body, avoids walls and refines standing height above thin ground',()=>{
    const bounds={left:0,top:12,right:18,bottom:24},shape={left:20,right:20,top:80,bottom:20};
    const floorY=23*96+7;
    const hitsAt=(px,py)=>px-shape.left<96?[{terrain:true,type:0}]:py+shape.bottom>=floorY?[{terrain:true,type:0}]:[];
    const pick=findCatalogLanding({bounds,shape,tileWidth:96,tileHeight:96,hitsAt});
    assert.equal(pick.grounded,true);assert.equal(hitsAt(pick.px,pick.py).length,0);
    assert.ok(pick.py+shape.bottom<floorY);assert.ok(floorY-(pick.py+shape.bottom)<=1);
    assert.ok(pick.px-shape.left>=96);assert.ok(pick.py-shape.top>=bounds.top*96);
    assert.ok(pick.py+shape.bottom<=bounds.bottom*96);
});

test('catalog landing refuses blocked or undersized cells and bounds its search',()=>{
    const args={bounds:{left:0,top:0,right:4,bottom:4},shape:{left:20,right:20,top:80,bottom:20},tileWidth:96,tileHeight:96};
    assert.equal(findCatalogLanding({...args,hitsAt:()=>[{terrain:true,type:0}]}),null);
    assert.equal(findCatalogLanding({...args,bounds:{left:0,top:0,right:1,bottom:0.5},hitsAt:()=>[]}),null);
    const limited=findCatalogLanding({...args,maxProbes:2,hitsAt:()=>[]});assert.equal(limited.grounded,false);assert.ok(limited.probes<=3);
    const floating=findCatalogLanding({...args,hitsAt:()=>[]});assert.equal(floating.grounded,false);
    const hazardous=findCatalogLanding({...args,hitsAt:()=>[{terrain:true,type:2}]});assert.equal(hazardous,null);
});

function runtime({blocked=false,blockAfterTransfer=false,blockedTargetCell=false}={}){
    class Character{
        constructor(){Object.assign(this,{px:500,py:500,_vx:0,_vy:0,dotX:0,dotY:0,_direction:6});}
        hitOffsetL(){return this._hitOffsetL??24;}hitOffsetR(){return this._hitOffsetR??24;}
        hitOffsetT(){return this._hitOffsetT??72;}hitOffsetB(){return this._hitOffsetB??16;}
        tileXToCenterX(x){return x*96+48;}tileYToCenterY(y){return y*96+80;}
        locate(x,y){this._x=x;this._y=y;this.unflush(x,y);}unflush(x,y){this.px=this.tileXToCenterX(x);this.py=this.tileYToCenterY(y);}
        suspendGravity(){this._suspendGravity=true;}resumeGravity(){this._suspendGravity=false;}
        suspendPhysicsHitTest(){this._suspendPhysicsHitTest=true;}resumePhysicsHitTest(){this._suspendPhysicsHitTest=false;}
        isSuspendGravity(){return !!this._suspendGravity;}clearImpact(){}clearGrounding(){}
        doGravity(){}makeMomentum(){}cacheDeltaTimeSpeed(){}isRemove(){return false;}
    }
    class Grid{
        rebuild(){}
        getObjGrid(p,hits){if(this.blocked||(this.blockedTargetCell&&p.px<10*96)||p.py+p.hitOffsetB()>=14*96)hits.push({terrain:true,type:0});}
    }
    class Map{
        mapId(){return this._mapId;}tileWidth(){return 96;}tileHeight(){return 96;}width(){return 20;}height(){return 16;}
        tilemapTerrain(){}isAnyEventStarting(){return false;}
    }
    const p=new Character(),map=new Map(),terrain=new Grid();map._mapId=1;map._terrain=terrain;terrain.blocked=blocked;terrain.blockedTargetCell=blockedTargetCell;
    const data={width:20,height:16,meta:{},events:[null,{id:1,x:10,y:10}]};
    const context=vm.createContext({window:{},Game_CharacterBase:Character,Game_Map:Map,PhysicsGrid:Grid,
        $gamePlayer:p,$gameLily:null,$gameActors:{},$gameMap:map,$dataMap:data,$dataMapInfos:[null,{},{}],
        SceneManager:{_scene:{constructor:{name:'Scene_Map'}}},setTimeout:fn=>fn(),
        DataManager:{getCachedData:()=>data,getThumbnailCell:(x,y,id)=>({x:0,y:0,mapId:id}),
            getThumbnailMapInfo:()=>({minX:0,maxX:blockedTargetCell?1:0,minY:0,maxY:0,data:blockedTargetCell?[{x:0,y:0},{x:1,y:0}]:[{x:0,y:0}]})}});
    const transfers=[];
    p.reserveTransfer=(id,x,y)=>{transfers.push(id);map._mapId=id;map._terrain=new Grid();map._terrain.blocked=id===2&&blockAfterTransfer;context.$dataMap=data;p._x=x;p._y=y;};
    p.isTransferring=()=>false;
    p.locate=()=>{throw Error('Catalog must use base locate, without the native player grounding adjustment');};
    return{context,p,map,transfers};
}

test('catalog travel validates before moving and arrives with hover and collision',async()=>{
    const f=runtime();const r=JSON.parse(await vm.runInContext(OPS.catalogTravel(1,1),f.context));
    assert.equal(r.ok,true);assert.equal(r.gravitySuspended,true);assert.equal(r.noclip,false);
    assert.equal(r.catalogCell.cellX,0);assert.ok(f.p.py+f.p.hitOffsetB()<14*96);
    const bad=runtime({blocked:true}),before=[bad.p.px,bad.p.py];
    const refused=JSON.parse(await vm.runInContext(OPS.catalogTravel(1,1),bad.context));
    assert.equal(refused.ok,false);assert.deepEqual([bad.p.px,bad.p.py],before);assert.deepEqual(bad.transfers,[]);
});

test('a blocked target cell expands to another cell in the same map and still teleports',async()=>{
    const f=runtime({blockedTargetCell:true});
    const r=JSON.parse(await vm.runInContext(OPS.catalogTravel(1,1),f.context));
    assert.equal(r.ok,true);assert.equal(r.catalogCell.cellX,1);assert.ok(f.p.px>10*96);
    assert.match(r.positionNote,/同图其他可用位置/);assert.equal(r.noclip,false);
});

test('catalog travel rechecks the loaded destination and returns on newly blocked geometry',async()=>{
    const f=runtime({blockAfterTransfer:true}),before=[f.p.px,f.p.py];
    const r=JSON.parse(await vm.runInContext(OPS.catalogTravel(2,1),f.context));
    assert.equal(r.ok,false);assert.match(r.error,/返回原位置/);
    assert.deepEqual(f.transfers,[2,1]);assert.equal(f.map.mapId(),1);assert.deepEqual([f.p.px,f.p.py],before);
});

test('world cell travel validates map and page before moving, and supports empty cells with safe fallback',async()=>{
    assert.throws(()=>OPS.worldMapTravel(1,0,0,'1'),/坐标无效/);
    const f=runtime({blockedTargetCell:true});
    f.context.DataManager._thumbnailMapCell={a:{mapId:1,x:0,y:0,page:3},b:{mapId:1,x:1,y:0,page:3}};
    const before=[f.p.px,f.p.py];
    for(const args of [[1,0,0,4],[2,0,0,3],[1,99,0,3]]){
        const r=JSON.parse(await vm.runInContext(OPS.worldMapTravel(...args),f.context));
        assert.equal(r.ok,false);assert.match(r.error,/不属于/);assert.deepEqual([f.p.px,f.p.py],before);
    }
    assert.deepEqual(f.transfers,[]);
    const r=JSON.parse(await vm.runInContext(OPS.worldMapTravel(1,0,0,3),f.context));
    assert.equal(r.ok,true);assert.equal(r.catalogCell.cellX,1);assert.equal(r.noclip,false);assert.equal(r.gravitySuspended,true);
});
