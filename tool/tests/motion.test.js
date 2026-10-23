const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installMotion } = require('../lib/motion');
const { OPS } = require('../lib/ops');

function fixture() {
    let now = 0;
    const timers = [];
    const character = () => ({ _x: 3, _y: 4, px: 3 * 96 + 40, py: 4 * 96 + 80, _vx: 0, _vy: 12,
        get vx() { return this._vx; }, set vx(v) { this._vx = v; },
        get vy() { return Math.round(this._vy); }, set vy(v) { this._vy = v; },
        g: () => 0, deltaTime: () => 1, doGravity() { this._vy += 0.5; }, updateMapBoundTransfer() { this.transfer = true; },
        makeMomentum() { this.rx = this.px + this._vx; this.ry = this.py + this._vy; },
        cacheDeltaTimeSpeed() { this._vx *= this.deltaTime(); this._vy *= this.deltaTime(); },
        startTestV() { if(!this._testV){this._testV=true;this._tvx=this._vx;this._tvy=this._vy;} },
        testV(v) {this.vx=v.x;this.vy=v.y;this.makeMomentum();},
        endTestV() {if(this._testV){this.vx=this._tvx;this.vy=this._tvy;this._testV=false;this.makeMomentum();}},
        tileXToCenterX: x => x * 96 + 40, tileYToCenterY: y => y * 96 + 80,
        locate(x,y) { this._x = Math.round(x); this._y = Math.round(y); this.unflush(x,y); },
        unflush(x,y) { this.px = Math.round(x * 96 + 40); this.py = Math.round(y * 96 + 80); },
        clearImpact() {}, clearGrounding() {}, suspendGravity() { this._suspendGravity = true; }, resumeGravity() { this._suspendGravity = false; },
        suspendPhysicsHitTest() { this._suspendPhysicsHitTest = true; }, resumePhysicsHitTest() { this._suspendPhysicsHitTest = false; },
        isSuspendGravity() { return !!this._suspendGravity; }, isRemove() { return false; },
        hitPreview() { return []; },
        isFlexibleGrounding() { return !!this.grounded; }, isTriggeredJump() { return !!this.jumpPressed; },
        isPressDown() { return !!this.downPressed; }, isOutControl() { return !!this.blocked; }, jumpStrength() { return -8; },
        controlJump() { if(this.grounded && this.jumpPressed)this.vy=-8; },
        controlDoubleJump() { if(!this.grounded && !this.useDoubleJump && this.jumpPressed) { this.vy=-6; this.useDoubleJump=true; } },
    });
    const p = character(), lily = character();
    const context = vm.createContext({ window: {}, $gamePlayer:p, $gameLily:lily, $dataMap: {},
        $gameMap: { g: () => 0.5, width: () => 20, height: () => 12, tileWidth: () => 96, tileHeight: () => 96, mapId: () => 1 },
        SceneManager: { _scene: { constructor: { name:'Scene_Map' } } },
        Date: { now: () => now }, setInterval: fn => timers.push(fn),
    });
    const api = vm.runInContext(`(${installMotion.toString()})()`, context);
    return { context, api, p, lily, advance(ms) { now += ms; timers.forEach(fn=>fn()); } };
}

test('hover stops falling, slows upward jump to zero, supports inverted gravity and restores hooks', () => {
    const f=fixture(), original=f.p.doGravity, transfer=f.p.updateMapBoundTransfer;
    f.api.enable(f.p); assert.equal(f.p._vy,0); assert.equal(f.p._suspendGravity,true);
    const saved=JSON.parse(JSON.stringify(f.p));
    assert.equal(Object.hasOwn(saved,'_suspendGravity'),false);
    assert.equal(Object.hasOwn(saved,'_suspendPhysicsHitTest'),false);
    f.p._vy=-8; const speeds=[];
    for(let i=0;i<40;i++) { f.p.doGravity(); speeds.push(f.p._vy); }
    assert.equal(speeds[0],-7.5); assert.equal(speeds.at(-1),0); assert.ok(speeds.every(v=>v<=0));
    f.p._vy=20; f.p.doGravity(); assert.equal(f.p._vy,0);
    f.p._vy=20; f.p.cacheDeltaTimeSpeed(); f.p.makeMomentum(); assert.equal(f.p.ry,f.p.py);
    f.p._testV=true; f.p._vy=5; f.p.makeMomentum(); assert.equal(f.p.ry,f.p.py+5); f.p._testV=false;
    f.p._invertMode=true; f.p._vy=8;
    for(let i=0;i<40;i++) f.p.doGravity();
    assert.equal(f.p._vy,0);
    f.p.updateMapBoundTransfer(); assert.equal(f.p.transfer,true);
    assert.equal(Object.keys(f.p).includes('doGravity'),false);
    f.api.clear(); assert.equal(f.p.doGravity,original); assert.equal(f.p.updateMapBoundTransfer,transfer);
    assert.equal(f.p._suspendGravity,false); assert.equal(f.p._suspendPhysicsHitTest,false);
});

test('noclip enables hover for both characters and refuses to restore collision inside terrain', async () => {
    const f=fixture();
    const run=async code=>JSON.parse(await vm.runInContext(code,f.context));
    assert.equal((await run(OPS.setNoclip(true))).ok,true);
    for(const c of [f.p,f.lily]) { assert.equal(c._suspendGravity,true); assert.equal(c._suspendPhysicsHitTest,true); c._vy=99; c.doGravity(); assert.equal(c._vy,0); }
    f.p.hitPreview=()=>[{terrain:true,type:0}];
    assert.equal((await run(OPS.setNoclip(false))).ok,false); assert.equal(f.p._suspendPhysicsHitTest,true);
    f.p.hitPreview=()=>[];
    assert.equal((await run(OPS.setNoclip(false))).ok,true); assert.equal(f.p._suspendPhysicsHitTest,false); assert.equal(f.p._suspendGravity,true);
});

test('pixel nudge uses physical position, accumulates exact small steps and respects map bounds', async () => {
    const f=fixture(), run=async code=>JSON.parse(await vm.runInContext(code,f.context));
    f.p.px=500; f.p.py=600;
    const first=await run(OPS.nudge(1,0,4)); assert.equal(first.px,504); assert.equal(first.py,600);
    const next=await run(OPS.nudge(1,0,4)); assert.equal(next.px,508);
    f.p.px=40; assert.equal((await run(OPS.nudge(-1,0,16))).px,40);
    f.p.py=80; assert.equal((await run(OPS.nudge(0,-1,1))).py,80);
    f.p.px=99999; f.p.py=99999; f.p.updateMapBoundTransfer(); assert.equal(f.p.px,19*96+40); assert.equal(f.p.py,11*96+80);
    assert.throws(()=>OPS.nudge(1,1,4)); assert.throws(()=>OPS.nudge(1,0,Infinity));
});

test('hover survives normal map changes but releases on save load and heartbeat expiry', () => {
    const f=fixture(); f.api.enable(f.p,true); f.advance(120001);
    assert.equal(f.api.has(f.p),false); assert.equal(f.p._suspendGravity,false);
    f.api.enable(f.p,true); f.context.$dataMap={}; f.p.resumeGravity();f.p.resumePhysicsHitTest();f.advance(1);
    assert.equal(f.api.has(f.p),true);assert.equal(f.p.isSuspendGravity(),true);assert.equal(f.p._suspendPhysicsHitTest,true);
    f.context.$gameMap={...f.context.$gameMap};f.advance(1);
    assert.equal(f.api.has(f.p),false);
});

test('hover allows repeated airborne jumps, manual descent, and preserves downward skill movement', () => {
    const f=fixture(), jump=f.p.controlJump, double=f.p.controlDoubleJump;
    f.p.useDoubleJump=true; f.api.enable(f.p); f.p.jumpPressed=true;
    for(let i=0;i<5;i++) { f.p._vy=0; f.p.controlJump({}); f.p.controlDoubleJump({}); assert.equal(f.p._vy,-8); }
    assert.equal(f.p.useDoubleJump,true);
    f.p.jumpPressed=false; f.p.downPressed=true; f.p.doGravity(); f.p.makeMomentum();
    assert.equal(f.p.ry-f.p.py,4);
    f.p.downPressed=false; f.p.doGravity(); f.p.makeMomentum(); assert.equal(f.p.ry,f.p.py);
    f.p._bodyAttacking='toru_down_dash_attack'; f.p._vy=22; f.p.doGravity(); f.p.makeMomentum(); assert.equal(f.p.ry-f.p.py,22);
    f.p.downPressed=true; f.p._vy=25; f.p.doGravity(); f.p.makeMomentum(); assert.equal(f.p.ry-f.p.py,25);
    f.p._bodyAttacking=''; f.p.downPressed=false; f.p.doGravity(); f.p.makeMomentum(); assert.equal(f.p.ry,f.p.py);
    f.p.blocked=true; f.p.downPressed=true; f.p.doGravity(); assert.equal(f.p._vy,0);
    f.api.clear(); assert.equal(f.p.controlJump,jump); assert.equal(f.p.controlDoubleJump,double);
});

test('native skill and stagger cleanup cannot cancel tool hover; disabling restores the native query', async () => {
    const f=fixture(), originalQuery=f.p.isSuspendGravity;
    f.api.enable(f.p);
    // The original game does this when a skill or stagger ends.
    f.p.resumeGravity();
    assert.equal(f.p._suspendGravity,false);
    assert.equal(f.api.has(f.p),true);
    assert.equal(f.p.isSuspendGravity(),true);
    f.p._vy=20; f.p.doGravity(); f.p.makeMomentum();
    assert.equal(f.p.ry,f.p.py);
    f.advance(15000);
    f.p.isInvincible=()=>false;
    Object.assign(f.context,{$dataMapInfos:[], $dataSystem:{switches:[]}, $gameSwitches:{value:()=>false}, Graphics:{}});
    const snap=JSON.parse(await vm.runInContext(OPS.snapshot(),f.context));
    assert.equal(snap.ok,true);
    assert.equal(snap.gravitySuspended,true);
    assert.equal(f.p.isSuspendGravity(),true);
    assert.equal(Object.keys(f.p).includes('isSuspendGravity'),false);
    f.api.disable(f.p);
    assert.equal(f.p.isSuspendGravity,originalQuery);
    assert.equal(f.p.isSuspendGravity(),false);
    // Native skill suspension must not turn the panel's tool switch back on.
    f.p.suspendGravity();
    assert.equal(JSON.parse(await vm.runInContext(OPS.snapshot(),f.context)).gravitySuspended,false);
});

test('hot upgrading an active v4 helper preserves hover, noclip and velocity', () => {
    const f=fixture(), nativeQuery=f.p.isSuspendGravity;
    f.api.enable(f.p,true); f.p._vx=3; f.p._vy=-7;
    f.api.version=4;
    const next=vm.runInContext(`(${installMotion.toString()})()`,f.context);
    assert.equal(next.version,5); assert.equal(next.has(f.p),true);
    assert.equal(f.p._suspendPhysicsHitTest,true);
    assert.equal(f.p._vx,3); assert.equal(f.p._vy,-7);
    f.p.resumeGravity(); assert.equal(f.p.isSuspendGravity(),true);
    next.clear(); assert.equal(f.p.isSuspendGravity,nativeQuery);
    assert.equal(f.p.isSuspendGravity(),false);
});

test('collision-resolved motion is preserved through grounding probes while holding down', () => {
    const f=fixture(), momentum=f.p.makeMomentum,cache=f.p.cacheDeltaTimeSpeed;
    f.api.enable(f.p); f.p.downPressed=true;
    assert.equal(f.p.makeMomentum,momentum);
    for(let i=0;i<30;i++){
        f.p.doGravity();f.p.cacheDeltaTimeSpeed();f.p.makeMomentum();
        assert.equal(f.p._vy,4);
        // Native solid-floor collision resolves to no vertical displacement.
        f.p._vy=0;f.p.makeMomentum();
        // generateObjectPhysicsInfo probes below, then restores resolved velocity.
        f.p.startTestV();f.p.testV({x:0,y:1});f.p.endTestV();
        assert.equal(f.p._vy,0);assert.equal(f.p.ry,f.p.py);
    }
    f.p.deltaTime=()=>0.5;f.p.cacheDeltaTimeSpeed();assert.equal(f.p._vy,2);
    f.api.clear();assert.equal(f.p.cacheDeltaTimeSpeed,cache);
});

test('native map exits run before the safety clamp; noclip side exits use native destinations', () => {
    const f=fixture();let nativeCalls=0,exitType=null,transferring=false;
    f.p.hitOffsetL=f.p.hitOffsetR=()=>12;f.p.hitOffsetT=()=>64;f.p.hitOffsetB=()=>16;
    f.p.updateMapBoundTransfer=()=>{nativeCalls++;};f.p.isTransferring=()=>transferring;
    f.p.autoTransfer=type=>{exitType=type;transferring=true;return true;};
    f.api.enable(f.p,true);f.p.px=-5;f.p.py=600;f.p.updateMapBoundTransfer();
    assert.equal(nativeCalls,1);assert.equal(exitType,3);assert.equal(f.p.px,-5);
    transferring=false;f.p.autoTransfer=()=>false;f.p.updateMapBoundTransfer();assert.equal(f.p.px,12);
    f.p.updateMapBoundTransfer();assert.equal(nativeCalls,3);
    f.api.setNoclip(f.p,false);f.context.$dataMap={};f.api.touch();assert.equal(f.p._suspendPhysicsHitTest,false);
    assert.equal(f.api.has(f.p),true);
});

test('normal map transitions retain helpers; transient loading and replaced actors do not revive old helpers', () => {
    const f=fixture();f.context.$gameActors={};f.api.touch();f.api.enable(f.p,true);
    f.context.$dataMap=null;f.context.SceneManager.isSceneChanging=()=>true;
    f.api.touch();assert.equal(f.api.has(f.p),true);
    f.context.$dataMap={};f.context.SceneManager.isSceneChanging=()=>false;
    f.p.resumePhysicsHitTest();f.p._vy=40;f.api.touch();
    assert.equal(f.p._suspendPhysicsHitTest,true);assert.equal(f.p._vy,0);
    f.context.$gameActors={};f.api.touch();
    assert.equal(f.api.has(f.p),false);assert.equal(f.p.isSuspendGravity(),false);
    f.context.$dataMap={};f.api.touch();assert.equal(f.api.has(f.p),false);
});
