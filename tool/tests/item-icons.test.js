const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readItemIcons}=require('../lib/item-icons');

test('item thumbnails use the native icon frames without creating sprites or writing files',async()=>{
    const draws=[];
    const bitmap={width:384,height:192,isReady:()=>true,canvas:{source:true}};
    const c=vm.createContext({items:[{type:'consumables',id:0},{type:'ornaments',id:25}],setTimeout,clearTimeout,
        Sprite_ItemIcon:{prototype:{itemBitmap:()=>bitmap,refreshIdx(id){this.setFrame(id===25?32:0,id===25?160:32,32,32);}}},
        document:{createElement:()=>({getContext:()=>({drawImage(...args){draws.push(args.slice(1));}}),toDataURL:()=> 'data:image/png;base64,dGVzdA=='})}});
    const result=JSON.parse(await vm.runInContext(`(${readItemIcons.toString()})(items).then(JSON.stringify)`,c));
    assert.equal(result.ok,true);assert.equal(Object.keys(result.icons).length,2);
    assert.deepEqual(draws[0],[0,32,32,32,0,0,32,32]);assert.deepEqual(draws[1],[32,160,32,32,0,0,32,32]);
});
