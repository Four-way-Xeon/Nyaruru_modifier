function installCombat() {
    if (window.__nyaruruCombat) return window.__nyaruruCombat;
    let settings={outgoing:1,incoming:1,oneHit:false}, attacker=null, touched=Date.now(), actors=$gameActors;
    const prototype=Game_CharacterBase.prototype;
    const hit=prototype.onAttackHit, direct=prototype.requestDamage, hooked=new WeakMap();
    const playerSide=c=>c===$gamePlayer || (typeof $gameLily!=='undefined' && c===$gameLily);
    function reset(){settings={outgoing:1,incoming:1,oneHit:false};}
    function touch(){if(actors!==$gameActors){reset();actors=$gameActors;}touched=Date.now();}
    function scale(character,value){
        if(!(value>0))return value;
        if(playerSide(character))return value*settings.incoming;
        const target=character.battleObject?.(), source=attacker?.battleObject?.();
        if(playerSide(attacker) && target && source && target.team!==source.team){
            const scaled=value*settings.outgoing;
            return settings.oneHit && !target.unlimitHp ? Math.max(scaled,target.hp+1) : scaled;
        }
        return value;
    }
    prototype.onAttackHit=function(info,character,...args){
        const previous=attacker;attacker=info?.bulletOwner||this;
        const already=character&&hooked.has(character);
        if(character&&!already){
            const descriptor=Object.getOwnPropertyDescriptor(character,'overrideBeAttackDamage'),original=character.overrideBeAttackDamage;
            hooked.set(character,{descriptor});
            Object.defineProperty(character,'overrideBeAttackDamage',{configurable:true,writable:true,enumerable:false,value(...values){return scale(this,original.apply(this,values));}});
        }
        try{return hit.call(this,info,character,...args);}finally{
            attacker=previous;
            if(character&&!already){const {descriptor}=hooked.get(character);if(descriptor)Object.defineProperty(character,'overrideBeAttackDamage',descriptor);else delete character.overrideBeAttackDamage;hooked.delete(character);}
        }
    };
    prototype.requestDamage=function(value,...args){return direct.call(this,playerSide(this)&&value>0?value*settings.incoming:value,...args);};
    const api={touch,clear:reset,read(){touch();return{ok:true,...settings};},change(patch){
        touch();const next={...settings};
        for(const key of ['outgoing','incoming'])if(patch[key]!==undefined){if(typeof patch[key]!=='number'||!Number.isFinite(patch[key])||patch[key]<0||patch[key]>1000)throw Error('倍率必须为 0～1000 的数字');next[key]=patch[key];}
        if(patch.oneHit!==undefined){if(typeof patch.oneHit!=='boolean')throw Error('秒杀开关无效');next.oneHit=patch.oneHit;}
        settings=next;return api.read();
    }};
    Object.defineProperty(window,'__nyaruruCombat',{value:api,configurable:true});
    setInterval(()=>{if(Date.now()-touched>120000||actors!==$gameActors){reset();actors=$gameActors;}},1000);
    return api;
}
module.exports={installCombat};
