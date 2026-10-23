const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
    const start=source.indexOf('// ---------- 收集百科 ----------'),end=source.indexOf('// ---------- 标签页 ----------',start);
    assert.ok(start>=0&&end>start);
    const a={key:'ornaments:0:14:1:0:9',type:'ornaments',id:0,mapId:14,mapName:'MAP014',area:'森林',
        eventId:1,pageIndex:0,x:9,y:22,collected:false,conditions:[]};
    const b={...a,key:'ornaments:0:88:2:0:9',mapId:88,mapName:'MAP088',area:'城堡',eventId:2,x:0,y:0};
    // HTTP JSON duplicates shared objects; item.locations and locations no longer
    // contain identical object references even though their keys still match.
    const encyclopedia=JSON.parse(JSON.stringify({context:'current',locations:[a,b],shops:[{...a,x:5,y:6}],
        items:[{type:'ornaments',id:0,name:'挂件',desc:'效果',count:0,shopCandidate:true,price:100,locations:[a,b]}]}));
    const elements=new Map(),calls=[],messages=[];let refreshed=0;
    const $=key=>{if(!elements.has(key))elements.set(key,{value:'',innerHTML:'',replaceChildren(){}});return elements.get(key);};
    const context=vm.createContext({$,ENCYCLOPEDIA:encyclopedia,ENCYCLOPEDIA_BUSY:false,ENCYCLOPEDIA_REVISION:0,
        CURRENT_CONTEXT:'current',CURRENT_GAME:{inMap:true},ITEM_TYPES:{ornaments:'配饰'},esc:v=>String(v??''),
        api:async(route,body)=>{calls.push({route,body:JSON.parse(JSON.stringify(body))});return{ok:true,positionNote:'目标分块边缘附近的可落脚空处'};},
        toast:(message,kind)=>messages.push({message,kind}),refreshStatus:()=>refreshed++});
    vm.runInContext(source.slice(start,end),context);
    const click=(attribute,value)=>$('#encyclopedia-items').onclick({target:{closest:()=>({
        hasAttribute:key=>key===attribute,dataset:{location:value,shop:value}})}});
    return{context,$,calls,messages,encyclopedia,click,refreshed:()=>refreshed};
}

test('encyclopedia buttons resolve JSON-loaded and filtered locations by stable key',async()=>{
    const f=fixture();assert.equal(f.encyclopedia.locations.indexOf(f.encyclopedia.items[0].locations[0]),-1);
    f.$('#encyclopedia-area').value='城堡';vm.runInContext('renderEncyclopedia()',f.context);
    const html=f.$('#encyclopedia-items').innerHTML;
    assert.match(html,/data-location="ornaments:0:88:2:0:9"/);assert.doesNotMatch(html,/data-location="-1"|data-location="ornaments:0:14/);
    await f.click('data-location','ornaments:0:88:2:0:9');
    assert.deepEqual(f.calls,[{route:'/encyclopedia/travel',body:{mapId:88,eventId:2}}]);
    assert.match(f.messages[0].message,/MAP088.*分块边缘.*碰撞已恢复/);assert.equal(f.refreshed(),1);
    await f.click('data-location','ornaments:0:14:1:0:9');
    assert.deepEqual(f.calls[1],{route:'/encyclopedia/travel',body:{mapId:14,eventId:1}});
});

test('encyclopedia still rejects stale locations and menu movement; shop travel keeps working',async()=>{
    const f=fixture();f.context.CURRENT_CONTEXT='another-map';
    await f.click('data-location','ornaments:0:14:1:0:9');assert.equal(f.calls.length,0);assert.match(f.messages.at(-1).message,/刷新百科/);
    f.context.CURRENT_CONTEXT='current';f.context.CURRENT_GAME.inMap=false;
    await f.click('data-location','ornaments:0:14:1:0:9');assert.equal(f.calls.length,0);assert.match(f.messages.at(-1).message,/关闭游戏菜单/);
    f.context.CURRENT_GAME.inMap=true;await f.click('data-location','missing');assert.equal(f.calls.length,0);
    await f.click('data-shop','0');assert.deepEqual(f.calls,[{route:'/encyclopedia/travel',body:{mapId:14,eventId:1}}]);
});
