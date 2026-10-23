const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installTrainer } = require('../lib/trainer');
const { OPS } = require('../lib/ops');

function fixture() {
    let now = 0;
    const timers = [];
    function makeActor() {
        const battle = { _hp: 80, mhp: 100, sp: 30, msp: 100, zp: 60, mzp: 200,
            get hp() { return this._hp | 0; },
            set hp(value) { if (this._hp !== 0) this._hp = Math.max(0, value); },
            addHp(delta) { this.hp = Math.min(this.mhp, Math.max(0, this._hp + delta)); },
            addSp(delta) { this.sp = Math.min(this.msp, Math.max(0, this.sp + delta)); },
            addZp(delta) { this.zp = Math.min(this.mzp, Math.max(0, this.zp + delta)); },
        };
        const definitions = { 0: { name: 'item0', desc: 'desc0', maxNum: 6 }, 1: { name: 'item1', maxNum: 2 } };
        function equipment(type) {
            return { _unlock: [0, 1], _equip: [0], _currentWeapon: 0,
                data: () => definitions, isUnlock(id) { return this._unlock.includes(id); },
                isEquip(id) { return this._equip.includes(id); }, currentWeapon() { return this._currentWeapon; },
                unlock(id) { if (!this.isUnlock(id)) { this._unlock.push(id); if (type === 'stones') this._equip.push(id); } },
                equip(id) { if (type === 'weapons') this._currentWeapon = id; else this._equip = this.isEquip(id) ? this._equip.filter(n => n !== id) : [...this._equip, id]; },
                remove(id) { this._equip = this._equip.filter(n => n !== id); this._unlock = this._unlock.filter(n => n !== id); },
            };
        }
        return { battle, hp: 1, _coin: 123, name: () => '喵露露', coin() { return this._coin; },
            addCoin(n) { this._coin = Math.min(99999, this._coin + n); },
            deductCoin(n) { if (this._coin < n) return false; this._coin -= n; return true; },
            _consumables: { _data: { 0: 3 }, data: () => definitions, itemNum(id) { return this._data[id] || 0; }, maxNum: id => definitions[id].maxNum,
                add(id, n, over) { this._data[id] = Math.max(0, Math.min(over ? Infinity : definitions[id].maxNum, this.itemNum(id) + n)); } },
            _weapons: equipment('weapons'), _stones: equipment('stones'), _ornaments: equipment('ornaments'),
            changeWeapon(id) { this._weapons.equip(id); },
            _joyCoin: 2, _hpStrengthItem: 1, _skillStrengthItem: 3,
            joyCoinData: () => definitions[0], hpStrengthData: () => definitions[0], skillStrengthData: () => definitions[0],
            joyCoinNum() { return this._joyCoin; }, hpStrengthNum() { return this._hpStrengthItem; }, skillStrengthNum() { return this._skillStrengthItem; },
        };
    }
    const actor = makeActor(), companion = makeActor();
    const player = { current: actor, lily: false, actor() { return this.current; }, battleObject() { return this.current.battle; }, isLilyMode() { return this.lily; }, setWeaponChange() { this.weaponChanged = true; } };
    const context = vm.createContext({ window: {}, $gamePlayer: player, $gameLily: { actor: () => companion }, $gameParty: {}, $gameActors: {},
        TextManager: { item0: '卷心菜', item1: '物品一', desc0: '恢复生命' },
        Date: { now: () => now }, setInterval: fn => { timers.push(fn); },
        $gameMap: { mapId: () => 1 }, SceneManager: { _scene: { constructor: { name: 'Scene_Map' } } },
    });
    const api = vm.runInContext(`(${installTrainer.toString()})()`, context);
    const change = body => api.change({ subject: api.read().subject, ...body });
    return { api, change, context, actor, companion, player, timers, makeActor, advance(ms) { now += ms; timers.forEach(fn => fn()); } };
}

test('trainer edits actual NYA values, supports Lily mode and rejects stale actor requests', () => {
    const f = fixture();
    f.change({ action: 'stat', field: 'coin', value: 9000 });
    f.change({ action: 'stat', field: 'hp', value: 95 });
    f.change({ action: 'stat', field: 'sp', value: 40 });
    f.change({ action: 'stat', field: 'zp', value: 150 });
    assert.equal(f.actor.hp, 1); assert.equal(f.actor.battle.hp, 95); assert.equal(f.actor.coin(), 9000);
    const old = f.api.read().subject;
    f.player.lily = true;
    assert.equal(f.api.read().role, '莉莉娅');
    assert.throws(() => f.api.change({ subject: old, action: 'stat', field: 'hp', value: 20 }), /角色已变化/);
    f.change({ action: 'stat', field: 'hp', value: 50 });
    assert.equal(f.actor.battle.hp, 50); assert.equal(f.companion.battle.hp, 80);
    for (const value of [null, '20', -1, 101, NaN, Infinity, 1.5]) {
        assert.throws(() => f.change({ action: 'stat', field: 'hp', value }), /整数/);
    }
    assert.equal(f.actor.battle.hp, 50);
    f.change({ action: 'stat', field: 'hp', value: 0 });
    assert.throws(() => f.change({ action: 'stat', field: 'hp', value: 50 }), /已倒下/);
});

test('locks stop lethal damage and spending immediately, survive form changes and restore descriptors', () => {
    const f = fixture(), b = f.actor.battle;
    for (const [field, value] of Object.entries({ hp: 70, sp: 45, zp: 90, coin: 1000 })) f.change({ action: 'stat', field, value, locked: true });
    b.hp = 0; b.sp -= 50; b.zp += 80;
    assert.equal(f.actor.deductCoin(999), true); f.actor.addCoin(500);
    assert.equal(b.hp, 70); assert.equal(b.sp, 45); assert.equal(b.zp, 90); assert.equal(f.actor.coin(), 1000);
    f.player.lily = true; b.hp = 0; assert.equal(b.hp, 70);
    b.mhp = 40; assert.equal(b.hp, 40);
    f.change({ action: 'stat', field: 'coin', value: 2000 });
    assert.equal(f.api.read().stats.coin.locked, true); assert.equal(f.actor.coin(), 2000);
    const saved = JSON.parse(JSON.stringify(f.actor));
    assert.equal(saved.battle._hp, 40); assert.equal(saved._coin, 2000);
    assert.equal(Object.keys(saved).some(k => /lock|trainer/i.test(k)), false);
    f.change({ action: 'stat', field: 'hp', locked: false });
    const desc = Object.getOwnPropertyDescriptor(b, '_hp');
    assert.equal(desc.value, 40); assert.equal(desc.writable, true); assert.equal(desc.enumerable, true);
    b.hp = 0; assert.equal(b.hp, 0);
    f.api.clear(); assert.equal(f.actor.deductCoin(500), true); assert.equal(f.actor.coin(), 1500);
});

test('locks follow current player objects but clear on load and heartbeat expiry; install is idempotent', () => {
    const f = fixture();
    f.change({ action: 'stat', field: 'sp', value: 55, locked: true });
    const other = f.makeActor(); f.player.current = other; f.advance(100);
    other.battle.sp = 0; assert.equal(other.battle.sp, 55);
    f.actor.battle.sp = 10; assert.equal(f.actor.battle.sp, 10);
    vm.runInContext(`(${installTrainer.toString()})()`, f.context); assert.equal(f.timers.length, 1);
    f.context.$gameActors = {}; f.context.$gameParty = {}; f.player.current = f.makeActor(); f.advance(100);
    assert.equal(f.api.read().stats.sp.locked, false); assert.equal(f.player.current.battle.sp, 30);
    f.change({ action: 'stat', field: 'coin', value: 500, locked: true });
    f.advance(120001); assert.equal(f.api.read().stats.coin.locked, false);
    f.player.current.addCoin(1); assert.equal(f.player.current.coin(), 501);
});

test('inventory accepts item zero, respects optional consumable cap and keeps equipment references valid', () => {
    const f = fixture();
    assert.equal(f.api.read().items[0].name, '卷心菜');
    const item = (type, id, count, extra = {}) => f.change({ action: 'item', type, id, count, ...extra });
    item('consumables', 0, 6); assert.equal(f.actor._consumables.itemNum(0), 6);
    assert.throws(() => item('consumables', 0, 7), /整数/);
    item('consumables', 0, 99, { overCap: true }); assert.equal(f.actor._consumables.itemNum(0), 99);
    item('consumables', 0, 0); assert.equal(f.actor._consumables.itemNum(0), 0);
    for (const type of ['stones', 'ornaments']) {
        item(type, 0, 0); assert.equal(f.actor['_' + type].isEquip(0), false); assert.equal(f.actor['_' + type].isUnlock(0), false);
        item(type, 0, 1); item(type, 0, 1); assert.equal(f.actor['_' + type]._unlock.filter(n => n === 0).length, 1);
    }
    item('weapons', 0, 0); assert.equal(f.actor._weapons.currentWeapon(), 1); assert.equal(f.player.weaponChanged, true);
    assert.throws(() => item('weapons', 1, 0), /保留一件/); assert.equal(f.actor._weapons.isUnlock(1), true);
    item('joycoin', 0, 500); assert.equal(f.actor.joyCoinNum(), 500);
    assert.throws(() => item('__proto__', 0, 1), /分类/);
    assert.throws(() => item('consumables', 999, 1), /不存在/);
    assert.throws(() => item('hpst', 1, 1), /编号/);
});

test('OPS wraps trainer scripts with map guard and returns structured validation failures', async () => {
    const f = fixture();
    const result = JSON.parse(await vm.runInContext(OPS.trainer(), f.context));
    assert.equal(result.ok, true); assert.equal(result.stats.hp.value, 80);
    const bad = JSON.parse(await vm.runInContext(OPS.trainer({ action: 'stat', field: 'hp', value: 999, subject: result.subject }), f.context));
    assert.equal(bad.ok, false); assert.match(bad.error, /整数/);
    f.context.SceneManager._scene.constructor.name = 'Scene_Title';
    const menu = JSON.parse(await vm.runInContext(OPS.trainer(), f.context));
    assert.equal(menu.ok, false); assert.match(menu.error, /进入地图/);
});

test('batch changes validate every entry before modifying and roll back failed game methods', () => {
    const f=fixture();
    assert.throws(()=>f.change({action:'batch',changes:[{type:'joycoin',id:0,count:9},{type:'ornaments',id:999,count:1}]}),/不存在/);
    assert.equal(f.actor.joyCoinNum(),2);
    assert.throws(()=>f.change({action:'batch',changes:[{type:'weapons',id:0,count:0},{type:'weapons',id:1,count:0}]}),/保留一件/);
    f.change({action:'batch',changes:[{type:'consumables',id:0,count:6},{type:'ornaments',id:1,count:0},{type:'joycoin',id:0,count:9}]});
    assert.equal(f.actor._consumables.itemNum(0),6); assert.equal(f.actor._ornaments.isUnlock(1),false); assert.equal(f.actor.joyCoinNum(),9);
    const original=f.actor._ornaments.unlock;
    f.actor._ornaments.unlock=()=>{throw Error('simulated failure');};
    assert.throws(()=>f.change({action:'batch',changes:[{type:'joycoin',id:0,count:20},{type:'consumables',id:0,count:1},{type:'ornaments',id:1,count:1}]}),/simulated/);
    assert.equal(f.actor.joyCoinNum(),9); assert.equal(f.actor._consumables.itemNum(0),6); assert.equal(f.actor._ornaments.isUnlock(1),false);
    f.actor._ornaments.unlock=original;
});

test('accessories equip and unequip; bells control extra capacity without altering map collection', () => {
    const f=fixture(), o=f.actor._ornaments;
    o._equip=[]; o._hasBuyBellNum=1;
    o.bellData=()=>({name:'bell',desc:'capacity'}); o.eventBellGainNum=()=>1;
    o.hasEquipNum=()=>o._equip.filter(id=>id!==20).length; o.maxEquip=()=>1+o._hasBuyBellNum+o.eventBellGainNum();
    o.unequip=id=>{o._equip=o._equip.filter(n=>n!==id);};
    o.equip=id=>{if(o.hasEquipNum()>=o.maxEquip())return false;if(!o.isEquip(id))o._equip.push(id);return true;};
    f.actor.bellNum=()=>o._hasBuyBellNum+o.eventBellGainNum();
    f.change({action:'equip',type:'ornaments',id:0,equipped:true}); assert.equal(o.isEquip(0),true);
    f.change({action:'equip',type:'ornaments',id:0,equipped:false}); assert.equal(o.isEquip(0),false);
    assert.throws(()=>f.change({action:'item',type:'bell',id:0,count:0}),/地图取得/);
    f.change({action:'item',type:'bell',id:0,count:8}); assert.equal(o.maxEquip(),9);
    o._equip=[0,1,2,3]; f.change({action:'item',type:'bell',id:0,count:1});
    assert.equal(o.hasEquipNum(),2); assert.equal(o.eventBellGainNum(),1); assert.equal(o._hasBuyBellNum,0);
    assert.equal(f.api.read().items.find(i=>i.type==='bell').min,1);
    const flags={'174,229,A':true,'222,6,A':false};
    f.context.DataManager={_cacheBell:[[174,229,'A'],[222,6,'A']]};
    f.context.$gameSelfSwitches={value:key=>!!flags[key.join(',')],setValue:(key,value)=>{flags[key.join(',')]=value;}};
    o.eventBellGainNum=()=>Number(flags['174,229,A'])+Number(flags['222,6,A']);
    f.change({action:'item',type:'bell',id:0,count:0,adjustMapBells:true});
    assert.equal(flags['174,229,A'],false); assert.equal(f.actor.bellNum(),0); assert.equal(o.maxEquip(),1);
    flags['174,229,A']=true;
    o.unlock=()=>{throw Error('bell rollback');};
    assert.throws(()=>f.change({action:'batch',changes:[{type:'bell',id:0,count:0,adjustMapBells:true},{type:'ornaments',id:0,count:1}]}),/bell rollback/);
    assert.equal(flags['174,229,A'],true); assert.equal(o._hasBuyBellNum,0);
});

test('trainer is usable in backpack menu and rejects title screen', async () => {
    const f=fixture(); f.context.SceneManager._scene.constructor.name='Scene_Menu';
    const read=JSON.parse(await vm.runInContext(OPS.trainer(),f.context)); assert.equal(read.ok,true);
    const changed=JSON.parse(await vm.runInContext(OPS.trainer({action:'item',type:'ornaments',id:0,count:0,subject:read.subject}),f.context));
    assert.equal(changed.ok,true); assert.equal(f.actor._ornaments.isUnlock(0),false);
    f.context.SceneManager._scene.constructor.name='Scene_Title';
    assert.equal(JSON.parse(await vm.runInContext(OPS.trainer(),f.context)).ok,false);
});
