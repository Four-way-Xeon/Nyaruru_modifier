const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function fixture() {
    const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
    const start=source.indexOf('// ---------- 世界地图 ----------'),end=source.indexOf('// ---------- 收集百科 ----------');
    const elements=new Map(),calls=[],messages=[];
    const $=key=>{
        if(!elements.has(key))elements.set(key,{value:'',checked:false,innerHTML:'',clientWidth:800,clientHeight:560,
            setAttribute(){},addEventListener(){},setPointerCapture(){}});
        return elements.get(key);
    };
    const data=JSON.parse(JSON.stringify({context:'current',regions:[{id:2,name:'小镇'}],pages:[{id:1},{id:2}],
        player:{cellKey:'1:3:4',page:1,regionId:2},coverage:{message:'映射 3/3'},
        cells:[{key:'1:3:4',page:1,mapId:14,regionId:2,x:3,y:4,explored:true,walls:{}},
            {key:'2:3:4',page:2,mapId:99,regionId:2,x:3,y:4,walls:{}}],
        markers:[false,true,null].map((collected,i)=>({key:'marker-'+i,cellKey:'1:3:4',type:'bell',id:0,collected,name:'铃铛',desc:'增加容量',official:true}))}));
    const context=vm.createContext({$,CURRENT_CONTEXT:'current',CURRENT_GAME:{inMap:true},ITEM_ICONS:{},ITEM_TYPES:{bell:'铃铛'},
        esc:v=>String(v??''),itemArt:()=>'',loadItemIcons(){},refreshStatus:async()=>{},
        api:async(route,body)=>{calls.push({route,body});return route==='/world-map'?data:{ok:true};},toast:message=>messages.push(message)});
    // Use the actual shared SVG definition, including its encoding, for coin markers.
    vm.runInContext(source.slice(source.indexOf('const COIN_ICON ='),source.indexOf('function invalidateTrainer')),context);
    vm.runInContext(source.slice(start,end),context);
    const run=code=>vm.runInContext(code,context);
    context.fixtureData=data;run('WORLD_MAP=fixtureData');$('#world-map-page').value='1';
    return {$,data,calls,messages,context,run};
}

test('map JSON marker keys associate correctly; overlapping page coordinates stay separated',()=>{
    const f=fixture();f.run('renderWorldMap()');
    assert.match(f.$('#world-map-drawing').innerHTML,/data-world-cell="1:3:4"/);
    assert.doesNotMatch(f.$('#world-map-drawing').innerHTML,/data-world-cell="2:3:4"/);
    assert.equal((f.$('#world-map-drawing').innerHTML.match(/data-world-marker=/g)||[]).length,3);
    f.run("WORLD_MAP_SELECTED='1:3:4';renderWorldMapDetail()");
    assert.match(f.$('#world-map-detail').innerHTML,/未收集 1 · 已收集 1 · 未知 1/);
});

test('mixed collected state never marks a group fully collected; unknown is not uncollected',()=>{
    const f=fixture(),state=f.run('worldMapState(WORLD_MAP.markers)');
    assert.equal(state.allCollected,false);assert.equal(state.missing,1);assert.equal(state.unknown,1);
    f.$('#world-map-missing').checked=true;assert.equal(f.run("worldMapMarkers('1:3:4').length"),1);
    f.run('renderWorldMap()');assert.doesNotMatch(f.$('#world-map-drawing').innerHTML,/data-world-marker="marker-[12]"/);
});

test('coin map markers render the shared double-rim paw SVG at every collection state',()=>{
    const f=fixture();
    for(const marker of f.data.markers)Object.assign(marker,{type:'coin',name:'金币',iconKey:'coin:0'});
    f.run('renderWorldMap()');
    const html=f.$('#world-map-drawing').innerHTML;
    assert.equal((html.match(/data:image\/svg\+xml/g)||[]).length,3);
    const svg=decodeURIComponent(f.run('COIN_ICON').split(',')[1]);
    assert.match(svg,/viewBox="0 0 32 32"/);
    assert.ok((svg.match(/<circle/g)||[]).length>=2);
});

test('map details explain conditions and branch sources without exposing JSON',()=>{
    const f=fixture();Object.assign(f.data.markers[0],{conditions:[{label:'已打开大门',met:true},{label:'击败守卫',met:false},{label:'剧情条件',met:null}],branch:true,sourceNote:'击打 8 次耗尽'});
    f.run("WORLD_MAP_SELECTED='1:3:4';renderWorldMapDetail()");
    const html=f.$('#world-map-detail').innerHTML;
    assert.match(html,/✓ 已打开大门；✕ 击败守卫；\? 剧情条件；位于条件分支，需满足剧情条件；击打 8 次耗尽/);
    assert.doesNotMatch(html,/"label"|"met"/);
});

test('travel uses cell coordinates and captured context, not marker event coordinates',async()=>{
    const f=fixture();await f.run("travelWorldMap('1:3:4')");
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{route:'/world-map/travel',body:{context:'current',mapId:14,cellX:3,cellY:4,page:1}}]);
});

test('stale contexts and game menus reject travel before any request',async()=>{
    const f=fixture();f.context.CURRENT_CONTEXT='changed';await f.run("travelWorldMap('1:3:4')");
    assert.equal(f.calls.length,0);assert.match(f.messages.at(-1),/刷新地图/);
    f.context.CURRENT_CONTEXT='current';f.context.CURRENT_GAME.inMap=false;await f.run("travelWorldMap('1:3:4')");
    assert.equal(f.calls.length,0);assert.match(f.messages.at(-1),/关闭游戏菜单/);
});

test('drag does not select or travel, but a tap selects by stable cell key',()=>{
    const f=fixture(),viewport=f.$('#world-map-viewport');
    const target={closest:selector=>selector==='[data-world-cell]'?{dataset:{worldCell:'1:3:4'}}:null};
    const down={button:0,pointerId:1,clientX:10,clientY:20,target,currentTarget:viewport};
    viewport.onpointerdown(down);viewport.onpointermove({...down,clientX:40});viewport.onpointerup(down);
    assert.equal(f.run('WORLD_MAP_SELECTED'),null);assert.equal(f.calls.length,0);
    viewport.onpointerdown(down);viewport.onpointerup(down);
    assert.equal(f.run('WORLD_MAP_SELECTED'),'1:3:4');assert.equal(f.calls.length,0);
});

test('poll refresh preserves selection and zoom; late response cannot restore invalidated data',async()=>{
    const f=fixture();f.run("WORLD_MAP_FITTED=true;WORLD_MAP_VIEW={x:123,y:234,scale:1.75};WORLD_MAP_SELECTED='1:3:4'");
    await f.run('loadWorldMap()');assert.equal(f.run('WORLD_MAP_VIEW.scale'),1.75);assert.equal(f.run('WORLD_MAP_VIEW.x'),123);
    assert.equal(f.run('WORLD_MAP_SELECTED'),'1:3:4');
    let finish;f.context.api=()=>new Promise(resolve=>{finish=resolve;});
    const pending=f.run('loadWorldMap()');f.context.CURRENT_CONTEXT='new-save';f.run('invalidateWorldMap()');finish(f.data);await pending;
    assert.equal(f.run('WORLD_MAP'),null);assert.equal(f.run('WORLD_MAP_SELECTED'),null);
});
