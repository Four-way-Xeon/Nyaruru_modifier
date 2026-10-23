const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readEncyclopedia } = require('../lib/encyclopedia');

test('encyclopedia separates ownership from collected flags and never guesses branch rewards', () => {
    const flags = {'14,1,A':true};
    const add=(type,idx,indent=0)=>({code:357,indent,parameters:['NYA.Utils','addItem','',{type,idx:String(idx),antiCollection:'false'}]});
    const event=(id,list,conditions={})=>({id,name:'pickup',x:id+1,y:4,pages:[{conditions,list}]});
    const map={events:[null,event(1,[add('hpst',0)]),event(2,[add('hpst',0)]),event(3,[add('ornaments',0,1),{code:123,indent:1,parameters:['A',0]}]),
        event(4,[{code:357,parameters:['NYA.Utils','shop','',{}]}]),event(5,[{code:357,parameters:['NYA.Utils','add_coin','',{num:'-20'}]}]),
        event(6,[{code:357,parameters:['NYA.EVENT.AI_Adapter','ai','',{type:'60',battleObject:'104'}]}]) ]};
    const inventory={subject:'actor',stats:{coin:{value:100}},items:[{type:'hpst',id:0,name:'逗猫棒',count:0},{type:'ornaments',id:0,name:'挂件',count:1}]};
    const actor={_ornaments:{data:()=>({0:{price:900,openTask:0}})},hpStrengthData:()=>({price:500})};
    const context=vm.createContext({inventory,$gamePlayer:{actor:()=>actor},DataManager:{_cacheMapData:{14:map},mapRegion:()=>2},
        $dataRegion:{2:{name:'幽暗之森',exploreItem:[[14,1],[14,2],[14,6]]}},$dataMapInfos:{14:{name:'MAP014'}},$dataSystem:{switches:[],variables:[]},
        $gameSwitches:{value:()=>false},$gameVariables:{value:()=>0},$gameSelfSwitches:{value:key=>!!flags[key.join(',')]}});
    const result=JSON.parse(vm.runInContext(`JSON.stringify((${readEncyclopedia.toString()})(inventory))`,context));
    assert.equal(result.items[0].count,0); assert.equal(result.items[0].locations[0].collected,true); assert.equal(result.items[0].locations[1].collected,false);
    assert.equal(result.items[1].locations[0].collected,null); assert.equal(result.items[1].shopCandidate,true);
    assert.equal(result.locations.length,4); assert.equal(result.shops.length,1);
    assert.equal(result.items[2].locations[0].kind,'coinpile'); assert.equal(result.items[2].locations[0].collected,false);
    assert.deepEqual(result.stats,{items:3,locations:4,shops:1,total:3,collected:1});
    assert.deepEqual(flags,{'14,1,A':true}); assert.equal(inventory.items[0].locations,undefined);
});

test('encyclopedia reports missing runtime map data instead of empty success', () => {
    const context=vm.createContext({DataManager:{_cacheMapData:{}},inventory:{}});
    assert.throws(()=>vm.runInContext(`(${readEncyclopedia.toString()})(inventory)`,context),/尚未加载/);
});
