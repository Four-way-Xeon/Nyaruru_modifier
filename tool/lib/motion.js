// Runs inside the game. Hooks live outside saved actors and can be fully removed.
function installMotion() {
    if (window.__nyaruruMotion?.version === 5) { window.__nyaruruMotion.touch(); return window.__nyaruruMotion; }
    // Preserve an active hover when upgrading the in-game helper after a service restart.
    const previous = window.__nyaruruMotion;
    const resume = [$gamePlayer, typeof $gameLily !== 'undefined' ? $gameLily : null]
        .filter(c => c && previous?.has(c)).map(c => ({ character:c, noclip:!!c._suspendPhysicsHitTest, vx:c._vx, vy:c._vy }));
    if (previous?.dispose) previous.dispose(); else previous?.clear();
    const records = new Map();
    const actorSet = () => typeof $gameActors !== 'undefined' ? $gameActors : null;
    let touched = Date.now(), player = $gamePlayer, data = $dataMap, map = $gameMap, actors = actorSet();
    const reset = c => {
        c.vx = c.vy = c._vx = c._vy = c.dotX = c.dotY = 0;
        c.clearImpact?.(); c._impact = null; c.clearGrounding?.();
        c._groundingX = c._terrainGroundingX = c.px;
        c._groundingY = c._terrainGroundingY = c.py;
    };
    function disable(c) {
        const r = records.get(c);
        if (!r) return;
        if (r.gravity) Object.defineProperty(c, 'doGravity', r.gravity); else delete c.doGravity;
        if (r.transfer) Object.defineProperty(c, 'updateMapBoundTransfer', r.transfer); else delete c.updateMapBoundTransfer;
        if (r.cache) Object.defineProperty(c, 'cacheDeltaTimeSpeed', r.cache); else delete c.cacheDeltaTimeSpeed;
        if (r.suspendCheck) Object.defineProperty(c, 'isSuspendGravity', r.suspendCheck); else delete c.isSuspendGravity;
        for (const [name, descriptor] of Object.entries(r.controls)) {
            if (descriptor) Object.defineProperty(c,name,descriptor); else delete c[name];
        }
        for (const [key, descriptor] of Object.entries(r.flags)) {
            if (descriptor) Object.defineProperty(c,key,{...descriptor,value:c[key]});
            else delete c[key];
        }
        records.delete(c); reset(c);
    }
    function clear() {
        for (const c of [...records.keys()]) {
            disable(c); c.resumeGravity?.(); c.resumePhysicsHitTest?.();
        }
    }
    function sync() {
        // Normal exits reuse these objects; loading a save replaces them.
        if (player !== $gamePlayer || map !== $gameMap || actors !== actorSet()) {
            clear(); player = $gamePlayer; map = $gameMap; actors = actorSet(); data = $dataMap;
        } else if (data !== $dataMap && $dataMap && $gameMap.mapId() > 0 &&
            SceneManager._scene?.constructor.name === 'Scene_Map' && !SceneManager.isSceneChanging?.()) {
            data = $dataMap;
            for (const [c, r] of records) {
                reset(c); c.suspendGravity();
                if (r.noclip) c.suspendPhysicsHitTest();
            }
        }
    }
    function touch() { sync(); touched = Date.now(); }
    function keepInMap(c) {
        if (!c.tileXToCenterX || !c.tileYToCenterY || !c.unflush) return;
        const tw=$gameMap.tileWidth(), th=$gameMap.tileHeight();
        const left=c.hitOffsetL?.() ?? c.tileXToCenterX(0), top=c.hitOffsetT?.() ?? c.tileYToCenterY(0);
        const right=$gameMap.width()*tw-(c.hitOffsetR?.() ?? tw-c.tileXToCenterX(0));
        const bottom=$gameMap.height()*th-(c.hitOffsetB?.() ?? th-c.tileYToCenterY(0));
        const px=Math.max(left,Math.min(right,c.px)),py=Math.max(top,Math.min(bottom,c.py));
        if(px===c.px && py===c.py)return;
        const blockedX=px!==c.px,blockedY=py!==c.py;
        const x=(px-c.tileXToCenterX(0))/tw,y=(py-c.tileYToCenterY(0))/th;
        const locate=typeof Game_CharacterBase!=='undefined' ? Game_CharacterBase.prototype.locate : c.locate;
        locate.call(c,x,y);c.unflush(x,y);
        if(blockedX){c.vx=0;c.dotX=0;}if(blockedY){c.vy=0;c.dotY=0;}
    }
    function enable(c, noclip = false) {
        if (!c) return;
        touch();
        if (!records.has(c)) {
            const gravity = Object.getOwnPropertyDescriptor(c, 'doGravity');
            const transfer = Object.getOwnPropertyDescriptor(c, 'updateMapBoundTransfer'), originalTransfer = c.updateMapBoundTransfer;
            const cache = Object.getOwnPropertyDescriptor(c, 'cacheDeltaTimeSpeed'), originalCache = c.cacheDeltaTimeSpeed;
            const originalGravity = c.doGravity;
            const suspendCheck = Object.getOwnPropertyDescriptor(c, 'isSuspendGravity');
            const flags = Object.fromEntries(['_suspendGravity','_suspendPhysicsHitTest'].map(key=>[key,Object.getOwnPropertyDescriptor(c,key)]));
            const controls = Object.fromEntries(['controlJump','controlDoubleJump'].map(key=>[key,Object.getOwnPropertyDescriptor(c,key)]));
            const record = { gravity, transfer, cache, suspendCheck, flags, controls, handledJump:false, noclip:!!(noclip || c._suspendPhysicsHitTest) };
            records.set(c, record);
            // Native skill/stagger cleanup calls resumeGravity(). Keep the tool's
            // hover independent, without blocking those native state transitions.
            Object.defineProperty(c, 'isSuspendGravity', { configurable:true, writable:true, enumerable:false, value() { return true; } });
            const skillActive = () => !!c._bodyAttacking;
            const descending = () => c === $gamePlayer && !c.isOutControl?.() && !!c.isPressDown?.();
            const extraJump = actor => {
                if (c !== $gamePlayer || c.isFlexibleGrounding?.() || !c.isTriggeredJump?.() || c.isOutControl?.()) return false;
                const sign = c._invertMode ? -1 : 1;
                const native = c.jumpStrength?.(actor);
                const strength = Number.isFinite(native) && native !== 0 ? Math.abs(native) : Math.abs(actor?.doubleJumpStrength?.() || 10);
                c.vy = -sign * strength;
                c.frameJump = true; c._nextFrameImmueElasticCollision = true; c._impact = null;
                if (typeof AudioManager !== 'undefined') AudioManager.playNormalSe?.('mtv_jump2');
                return true;
            };
            for (const name of ['controlJump','controlDoubleJump']) {
                const original = c[name];
                if (typeof original !== 'function') continue;
                Object.defineProperty(c,name,{configurable:true,writable:true,enumerable:false,value(...args) {
                    if (name === 'controlJump') record.handledJump = false;
                    else if (record.handledJump) return true;
                    if (extraJump(args[0])) { record.handledJump = true; return true; }
                    return original.apply(this,args);
                }});
            }
            Object.defineProperty(c, 'doGravity', { configurable: true, writable: true, enumerable: false, value() {
                sync();
                if (!records.has(c)) return originalGravity.apply(this,arguments);
                // Positive Y is down; reversed-gravity scenes use the other sign.
                const sign = this._invertMode ? -1 : 1;
                const vy = Number.isFinite(this._vy) ? this._vy : Number(this.vy) || 0;
                const g = Math.max(0.1, Math.abs(Number($gameMap.g?.() || 0) + Number(this.g?.() || 0)) || 0.35);
                if (!skillActive()) {
                    if (descending()) this.vy = sign * 4;
                    else this.vy = vy * sign < 0 ? sign * Math.min(0, vy * sign + g * Math.max(0.1, Math.min(2, this.deltaTime?.() || 1))) : 0;
                }
                this.setTempGravity?.(0); this.setTempMGravity?.(0);
            } });
            // Apply intent once BEFORE time scaling and collision resolution.
            // makeMomentum is also called AFTER collisions by endTestV; changing
            // velocity there overwrites the resolved floor contact and tunnels down.
            if (typeof originalCache === 'function') Object.defineProperty(c, 'cacheDeltaTimeSpeed', {
                configurable:true, writable:true, enumerable:false, value(...args) {
                    sync();
                    if (records.has(c) && !this._testV && !skillActive()) {
                        if (descending()) this.vy = (this._invertMode ? -1 : 1) * 4;
                        else if (this._vy * (this._invertMode ? -1 : 1) > 0) this.vy = 0;
                    }
                    return originalCache.apply(this,args);
                }
            });
            if(c === $gamePlayer && typeof originalTransfer === 'function') Object.defineProperty(c,'updateMapBoundTransfer',{
                configurable:true,writable:true,enumerable:false,value(...args){
                    sync();
                    const result=originalTransfer.apply(this,args);
                    if(!records.has(c) || this.isTransferring?.() || $gameMap.isEventRunning?.())return result;
                    // Side walls sit outside the map, and noclip has no impact.
                    // Resolve real exits before our tighter fallback boundary.
                    const left=this.px-(this.hitOffsetL?.()||0)<0;
                    const right=this.px+(this.hitOffsetR?.()||0)>$gameMap.width()*$gameMap.tileWidth();
                    const down=this.py+(this.hitOffsetB?.()||0)>$gameMap.height()*$gameMap.tileHeight();
                    if((left && this.autoTransfer?.(3)) || (right && this.autoTransfer?.(4)) || (down && this.autoTransfer?.(2)))return result;
                    if(!this.isTransferring?.())keepInMap(this);
                    return result;
                }
            });
        }
        records.get(c).noclip=!!(noclip || c._suspendPhysicsHitTest);
        reset(c); c.suspendGravity();
        if (noclip) c.suspendPhysicsHitTest();
        // These are temporary tool states. Omitting them from saves avoids loading
        // suspended gravity without the per-session controller that stops a jump.
        for (const key of ['_suspendGravity','_suspendPhysicsHitTest']) {
            const descriptor=Object.getOwnPropertyDescriptor(c,key);
            if (descriptor?.configurable && 'value' in descriptor) Object.defineProperty(c,key,{...descriptor,enumerable:false});
        }
    }
    let timer;
    const api = { version:5, touch, enable, disable, clear, has: c => records.has(c), reset,
        setNoclip(c,on) { if(on)enable(c,true);else {const r=records.get(c);if(r)r.noclip=false;c.resumePhysicsHitTest();} },
        dispose() { clear(); if (typeof clearInterval === 'function') clearInterval(timer); } };
    Object.defineProperty(window, '__nyaruruMotion', { value: api, configurable: true });
    if (typeof setInterval === 'function') timer = setInterval(() => {
        if (Date.now() - touched > 120000) clear(); else sync();
    }, 1000);
    for (const r of resume) { enable(r.character,r.noclip); r.character._vx=r.vx; r.character._vy=r.vy; }
    return api;
}
module.exports = { installMotion };
