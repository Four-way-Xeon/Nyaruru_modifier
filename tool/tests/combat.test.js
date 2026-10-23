const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {installCombat}=require('../lib/combat');
test('combat scales player attacks and incoming damage, supports bullets and respects healing and scripted immunity',()=>{
    function Character(team){this.battle={team,hp:100,unlimitHp:false};}
    Character.prototype.battleObject=function(){return this.battle;};
    Character.prototype.overrideBeAttackDamage=function(d){return d;};
    Character.prototype.onAttackHit=function(info,target){const d=target.overrideBeAttackDamage(info.damage);if(!target.battle.unlimitHp)target.battle.hp-=d;return d;};
    Character.prototype.requestDamage=function(d){this.battle.hp-=d;};
    const p=new Character(0),lily=new Character(0),enemy=new Character(1),other=new Character(1),timers=[];
    const c=vm.createContext({window:{},Game_CharacterBase:Character,$gamePlayer:p,$gameLily:lily,$gameActors:{},setInterval:fn=>timers.push(fn)});
    const api=vm.runInContext(`(${installCombat.toString()})()`,c);
    // The real Player and Event classes override the base method independently.
    enemy.overrideBeAttackDamage=function(d){return d;};p.overrideBeAttackDamage=function(d){return d;};
    api.change({outgoing:3,incoming:0.5});assert.equal(p.onAttackHit({damage:10},enemy),30);
    assert.equal(enemy.onAttackHit({damage:10},p),5);p.requestDamage(10);assert.equal(p.battle.hp,90);
    assert.equal(other.onAttackHit({damage:10,bulletOwner:p},enemy),30);
    assert.equal(enemy.onAttackHit({damage:-10},p),-10);
    api.change({oneHit:true});p.onAttackHit({damage:1},enemy);assert.ok(enemy.battle.hp<=0);
    enemy.battle.hp=100;enemy.battle.unlimitHp=true;p.onAttackHit({damage:1},enemy);assert.equal(enemy.battle.hp,100);
    assert.throws(()=>api.change({outgoing:Infinity}));assert.throws(()=>api.change({incoming:-1}));
    c.$gameActors={};api.read();assert.equal(api.read().outgoing,1);assert.equal(api.read().oneHit,false);
});
