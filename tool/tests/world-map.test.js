const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readWorldMap}=require('../lib/world-map');

test('world schematic preserves page boundaries, per-item collection and unexplored cells without writes',()=>{
    const cells=[{x:1,y:2,page:1,mapId:7,regionId:2,l:true,pt:true},
        {x:1,y:2,page:2,mapId:8,regionId:3,hidden:true}];
    const locations=[{key:'a',type:'hpst',id:0,mapId:7,eventId:1,x:4,y:4,collected:true,official:true},
        {key:'b',type:'hpst',id:0,mapId:7,eventId:2,x:4,y:4,collected:false,official:true},
        {key:'c',type:'hpst',id:0,mapId:8,eventId:3,x:4,y:4,collected:null,official:false}];
    const encyclopedia={items:[{type:'hpst',id:0,name:'强化',desc:'效果'}],locations};
    const before=JSON.stringify({cells,encyclopedia});
    const context=vm.createContext({encyclopedia,DataManager:{_thumbnailMapCell:{a:cells[0],b:cells[1]},
        makePosKey:(x,y)=>x+':'+y,getThumbnailCell:(x,y,id)=>cells.find(c=>c.mapId===id),getCurrentThumbnailCell:()=>cells[1]},
        $gameSystem:{isThumbnailActive:()=>false},$dataMapInfos:{},$dataRegion:{2:{name:'森林',exploreItem:[[7,1],[7,2],[7,9]]},3:{name:'里'}},
        $gameMap:{mapId:()=>8},$gamePlayer:{_x:5,_y:6}});
    const r=JSON.parse(vm.runInContext(`JSON.stringify((${readWorldMap.toString()})(encyclopedia))`,context));
    assert.equal(r.cells.length,2);assert.equal(r.pages.length,2);
    assert.deepEqual(r.markers.map(m=>m.collected),[true,false,null]);
    assert.deepEqual(r.markers.map(m=>m.cellKey),['1:1:2','1:1:2','2:1:2']);
    assert.equal(r.cells[0].walls.left,true);assert.equal(r.cells[0].exits.top,true);
    assert.equal(r.cells[1].explored,false);assert.equal(r.cells[1].hidden,true);
    assert.equal(r.player.cellKey,'2:1:2');assert.equal(r.markers[0].name,'强化');
    assert.equal(r.coverage.mappedOfficial,2);assert.equal(r.coverage.officialTotal,3);assert.deepEqual(r.coverage.missing,['7:9']);
    assert.equal(JSON.stringify({cells,encyclopedia}),before);
});
