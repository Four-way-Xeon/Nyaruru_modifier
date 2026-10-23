const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');
const SAFETY = require('../lib/safety');
const FILES = require('../lib/files');
const { OPS } = require('../lib/ops');
const { loadAll } = require('../lib/data');
const { storyPosition, chooseStoryPosition } = require('../lib/story-position');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nyaruru-regression-')));
    t.after(() => {
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
        assert.match(path.basename(resolved), /^nyaruru-regression-/);
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const game = path.join(root, 'game'), sandbox = path.join(root, 'sandbox'), backup = path.join(root, 'backups');
    fs.mkdirSync(path.join(game, 'save'), { recursive: true });
    fs.mkdirSync(path.join(game, 'aitemp', 'tool'), { recursive: true });
    fs.writeFileSync(path.join(game, 'save', 'file1.rmmzsave'), 'first');
    fs.writeFileSync(path.join(game, 'save', 'global.rmmzsave'), 'global');
    fs.writeFileSync(path.join(game, 'save', 'steam_autocloud.vdf'), 'cloud');
    fs.writeFileSync(path.join(game, 'package.json'), '{}');
    fs.writeFileSync(path.join(game, 'index.html'), 'game');
    return { root, game, sandbox, backup, tool: path.join(game, 'aitemp', 'tool') };
}
test('reject overlapping paths, relative paths and identical ports at startup and save', t => {
    const f = fixture(t), defaults = { cdpPort: 9223, webPort: 8787, sandboxDir: f.sandbox };
    assert.equal(SAFETY.validateConfig(defaults, f.game).sandboxDir, f.sandbox);
    for (const patch of [{ cdpPort: 8787 }, { sandboxDir: f.game }, { sandboxDir: f.root }, { sandboxDir: path.join(f.game, 'nested') }, { sandboxDir: 'relative' }]) {
        assert.throws(() => SAFETY.validateConfig({ ...defaults, ...patch }, f.game));
    }
    const file = path.join(f.root, 'config.json');
    fs.writeFileSync(file, '{bad'); assert.throws(() => SAFETY.readConfig(file, defaults, f.game), /损坏/);
    fs.writeFileSync(file, JSON.stringify({ webPort: 9223 })); assert.throws(() => SAFETY.readConfig(file, defaults, f.game), /不能相同/);
});

test('standalone layout uses configured game directory and rejects incomplete or overlapping targets', t => {
    const f = fixture(t);
    const defaults = { cdpPort: 9224, webPort: 8788, sandboxDir: f.sandbox, gameDir: f.game };
    const inferred = path.join(f.root, 'unrelated-workspace');
    assert.equal(SAFETY.validateConfig(defaults, inferred).gameDir, f.game);
    assert.throws(() => SAFETY.validateConfig({ ...defaults, sandboxDir: path.join(f.game, 'copy') }, inferred), /完全分开/);
    assert.throws(() => SAFETY.validateConfig({ ...defaults, gameDir: f.root }, inferred), /缺少/);
    assert.throws(() => SAFETY.validateConfig({ ...defaults, gameDir: 'relative' }, inferred), /绝对路径/);
    const configFile = path.join(f.tool, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(defaults));
    const config = SAFETY.readConfig(configFile, {}, inferred);
    assert.equal(config.gameDir, f.game);
    assert.equal(FILES.sandboxStatus(config.gameDir, config.sandboxDir, path.dirname(f.tool)).ready, false);
});
test('backup is unique, verifies content, records source and rejects traversal/corruption', t => {
    const f = fixture(t);
    const a = FILES.backupSaves(f.backup, f.game, 'original');
    fs.writeFileSync(path.join(f.game, 'save', 'file1.rmmzsave'), 'second');
    const b = FILES.backupSaves(f.backup, f.game, 'original');
    assert.notEqual(a.name, b.name);
    assert.equal(fs.readFileSync(path.join(a.dir, 'file1.rmmzsave'), 'utf8'), 'first');
    assert.equal(FILES.listBackups(f.backup)[0].sourceDir, f.game);
    assert.throws(() => FILES.inspectBackup(f.backup, '../outside'), /非法/);
    fs.writeFileSync(path.join(a.dir, 'file1.rmmzsave'), 'corrupt');
    assert.throws(() => FILES.inspectBackup(f.backup, a.name), /校验失败/);
    assert.equal(FILES.listBackups(f.backup).length, 1);
});
test('restore produces exact save set, preserves cloud settings, keeps previous directory', t => {
    const f = fixture(t), b = FILES.backupSaves(f.backup, f.game, 'original');
    fs.writeFileSync(path.join(f.game, 'save', 'file1.rmmzsave'), 'changed');
    fs.writeFileSync(path.join(f.game, 'save', 'file9.rmmzsave'), 'extra');
    const r = FILES.restoreBackup(f.backup, b.name, f.game);
    assert.equal(fs.readFileSync(path.join(f.game, 'save', 'file1.rmmzsave'), 'utf8'), 'first');
    assert.equal(fs.existsSync(path.join(f.game, 'save', 'file9.rmmzsave')), false);
    assert.equal(fs.readFileSync(path.join(f.game, 'save', 'steam_autocloud.vdf'), 'utf8'), 'cloud');
    assert.equal(fs.readFileSync(path.join(r.previousDirectory, 'file9.rmmzsave'), 'utf8'), 'extra');
    assert.ok(r.safetyBackup);
});
test('empty backup is rejected and legacy backups remain readable', t => {
    const f = fixture(t);
    const empty = path.join(f.root, 'empty'); fs.mkdirSync(path.join(empty, 'save'), { recursive: true });
    assert.throws(() => FILES.backupSaves(f.backup, empty), /没有找到/);
    const legacy = path.join(f.backup, '20261002_123456'); fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'file1.rmmzsave'), 'old');
    assert.equal(FILES.listBackups(f.backup)[0].legacy, true);
});
test('sandbox rejects partial copy; actual robocopy excludes both tool versions', { skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t);
    fs.mkdirSync(f.sandbox); fs.writeFileSync(path.join(f.sandbox, 'package.json'), '{}');
    assert.equal(FILES.sandboxStatus(f.game, f.sandbox, path.dirname(f.tool)).ready, false);
    fs.mkdirSync(path.join(f.game, 'aitemp发布版')); fs.writeFileSync(path.join(f.game, 'aitemp发布版', 'private.txt'), 'no copy');
    const target = path.join(f.root, 'complete');
    await FILES.copySandbox(f.game, target, path.dirname(f.tool));
    assert.equal(FILES.sandboxStatus(f.game, target, path.dirname(f.tool)).ready, true);
    assert.equal(fs.existsSync(path.join(target, 'aitemp')), false);
    assert.equal(fs.existsSync(path.join(target, 'aitemp发布版')), false);
    assert.equal(fs.readFileSync(path.join(target, 'save', 'file1.rmmzsave'), 'utf8'), 'first');
    fs.writeFileSync(path.join(target, '.nyaruru-sandbox-incomplete'), 'interrupted');
    assert.equal(FILES.sandboxStatus(f.game, target, path.dirname(f.tool)).ready, false);
});

function character() {
    return { _x: 1, _y: 1, px: 48, py: 48, _suspendPhysicsHitTest: true, gravity: true,
        locate(x, y) { this._x = x; this._y = y; },
        clearImpact() {}, clearGrounding() {}, resumeFriction() {}, unlockInvincible() {},
        suspendGravity() { this.gravity = true; }, resumeGravity() { this.gravity = false; },
        suspendPhysicsHitTest() { this._suspendPhysicsHitTest = true; }, resumePhysicsHitTest() { this._suspendPhysicsHitTest = false; },
        isSuspendGravity() { return this.gravity; }, isInvincible() { return false; },
        isRemove() { return !!this.removed; }, hitPreview() { return [{ terrain: true, type: 0 }]; },
    };
}
function gameContext() {
    const c = { window: {}, $gamePlayer: character(), $gameLily: character(), $dataMapInfos: [null, {}, {}], $dataMap: {},
        SceneManager: { _scene: { constructor: { name: 'Scene_Map' } } },
        $gameMap: { mapId: () => 1, width: () => 20, height: () => 20, tileHeight: () => 48 },
    };
    vm.createContext(c); return c;
}
async function run(c, script) { return JSON.parse(await vm.runInContext(script, c)); }
test('land restores both companions, preserves unsafe lily and restore handles hidden lily', async () => {
    const c = gameContext(); assert.equal((await run(c, OPS.land())).ok, true);
    assert.equal(c.$gamePlayer.gravity, false); assert.equal(c.$gameLily.gravity, false);
    assert.equal(c.$gameLily._suspendPhysicsHitTest, false);
    c.$gameLily.hitPreview = () => [{ terrain: true, type: 2 }];
    const unsafe = await run(c, OPS.land()); assert.match(unsafe.warning, /不安全/); assert.equal(c.$gameLily.gravity, true);
    c.$gameLily.removed = true; await run(c, OPS.restoreAll());
    assert.equal(c.$gameLily.gravity, false); assert.equal(c.$gameLily._suspendPhysicsHitTest, false);
});
test('invalid coordinates cannot reach locate; unfinished transfer fails and cancels reservation', async () => {
    assert.throws(() => OPS.teleport(NaN, 2)); assert.throws(() => OPS.teleport('', 2)); assert.throws(() => OPS.teleport(1, 2, { mapId: -1 }));
    const c = gameContext(); let id = 1, now = 0, cancelled = false;
    c.$gameMap.mapId = () => id; c.$gamePlayer.reserveTransfer = () => { id = 2; };
    c.$gamePlayer.isTransferring = () => true; c.$gamePlayer.clearTransferInfo = () => { cancelled = true; };
    c.Date = { now: () => now }; c.setTimeout = (fn, ms) => { now += ms; fn(); };
    const result = await run(c, OPS.teleport(3, 4, { mapId: 2 }));
    assert.equal(result.ok, false); assert.equal(cancelled, true); assert.equal(now, 12000);
});
test('identity is based on runtime storage path and changes for reload and revisiting a map', async () => {
    const c = gameContext();
    c.require = require; c.process = { mainModule: { filename: path.join(os.tmpdir(), 'game', 'index.html') } };
    c.StorageManager = { fileDirectoryPath: () => path.join(os.tmpdir(), 'game', 'save') };
    c.location = { href: 'chrome-extension://id/index.html', pathname: '/index.html' };
    const a = await run(c, OPS.selfPath()); c.$dataMap = {};
    const b = await run(c, OPS.selfPath()); assert.notEqual(a.mapToken, b.mapToken);
    c.$gamePlayer = character(); const d = await run(c, OPS.selfPath()); assert.notEqual(b.mapToken, d.mapToken);
    assert.equal(a.gameDir, path.join(os.tmpdir(), 'game'));
});
test('scene pin is inert and reversible; staging permits all game saves and panel saves', async () => {
    const c = gameContext(); let started = 0, saved = 0;
    let now = 0, watchdog;
    c.Date = { now: () => now }; c.setInterval = fn => { watchdog = fn; };
    c.Game_Map = function() {}; c.Game_Map.prototype.setup = function() {};
    c.DataManager = { maxSavefiles: () => 23, extractSaveContents() {} };
    const saveMethods = ['saveGame', 'saveGameHidden', 'autoSaveGame', 'autoSaveGameInternal'];
    const originals = {};
    for (const name of saveMethods) {
        originals[name] = c.DataManager[name] = function(slot) {
            assert.equal(this, c.DataManager); assert.equal(slot, 23);
            saved++; return Promise.resolve(name);
        };
    }
    c.$gameSystem = { onBeforeSave() {} }; c.SceneManager.snapForBackground = () => {};
    c.StorageManager = { saveZip() {}, saveObject() {} };
    const ev = { _erased: true, _pageIndex: -1, physics: true, _statemMembers: { name: 'old' },
        eventId: () => 1, event: () => ({ name: 'event', pages: [{ image: { characterName: 'body' } }] }),
        findProperPageIndex: () => 0, setupPageSettings() { this._trigger = 4; this._interpreter = {}; this._statemMembers.name = 'new'; },
        characterName: () => 'body', start() { started++; }, update() { this.start(); },
    };
    const originalUpdate = ev.update; c.$gameMap.events = () => [ev]; c.$gameMap.requestRefresh = () => {};
    assert.equal((await run(c, OPS.forcePage(1, 0))).ok, true);
    ev.update(); ev.start(); assert.equal(started, 0); assert.equal(ev._interpreter, null); assert.equal(ev.physics, false);
    for (const name of saveMethods) {
        assert.equal(c.DataManager[name], originals[name]);
        assert.equal(await c.DataManager[name](23), name);
    }
    assert.equal(saved, 4);
    assert.equal((await run(c, OPS.savePhotoSlot(23))).ok, true); assert.equal(saved, 5);
    assert.equal(c.window.__nyaruruPhoto.count(), 1); assert.equal(ev.physics, false);
    await run(c, OPS.unpinPages()); assert.equal(ev._erased, true); assert.equal(ev._pageIndex, -1);
    assert.equal(ev.update, originalUpdate); assert.equal(ev._statemMembers.name, 'old');
    await c.DataManager.saveGame(23); assert.equal(saved, 6);
    await run(c, OPS.forcePage(1, 0)); now = 119000; watchdog(); assert.equal(c.window.__nyaruruPhoto.count(), 1);
    c.window.__nyaruruPhoto.touch(); now += 119000; watchdog(); assert.equal(c.window.__nyaruruPhoto.count(), 1);
    now += 2000; watchdog(); assert.equal(c.window.__nyaruruPhoto.count(), 0); assert.equal(ev._erased, true);
});
test('staged actors settle on terrain, animate without AI and face the player; undo restores pose', async () => {
    const c = gameContext(); let aiCalls = 0;
    c.Game_Map = function() {}; c.Game_Map.prototype.setup = function() {};
    c.DataManager = { extractSaveContents() {} };
    c.$gameMap.tileWidth = c.$gameMap.tileHeight = () => 96;
    c.$gameMap.requestRefresh = () => {};
    c.ImageFrame = { info: () => ({ width: 3, height: 1 }) };
    const ai = { smoothfloor: 'true', skipSmoothfloor: 'false', fix: 'false' };
    const ev = { _x: 16, _y: 12, _realX: 16, _realY: 12, px: 1584, py: 1248, rx: 1584, ry: 1248,
        _direction: 6, _directionFix: true, _framePos: 0, physics: true, fix: false,
        eventId: () => 1, event: () => ({ pages: [{ list: [{ code: 357, parameters: ['ai-plugin', 'ai', '', ai] }] }] }),
        setupPageSettings() {}, characterName: () => 'actor',
        tileXToCenterX: x => (x + 0.5) * 96, tileYToCenterY: y => (y + 1) * 96,
        locate(x, y) { this._realX = x; this._realY = y; this._x = Math.round(x); this._y = Math.round(y); this.px = this.rx = (x + 0.5) * 96; this.py = this.ry = (y + 1) * 96; },
        setDirection(d) { if (!this._directionFix) this._direction = d; },
        update() { aiCalls++; }, start() { aiCalls++; },
        updateFrameAnimation(info) { this._framePos = (this._framePos + 1) % info.width; },
        hitPreview(dx, dy) { return [{ terrain: false, type: 0 }, ...(dy >= 47 ? [{ terrain: true, type: 0 }] : [])]; },
    };
    c.$gameMap.events = () => [ev]; c.$gamePlayer.px = 1488;
    const originalUpdate = ev.update;
    await run(c, OPS.forcePage(1, 0));
    assert.equal(ev.py, 1294); assert.equal(ev.ry, 1294); assert.equal(ev.physics, false);
    assert.equal(ev._direction, 4); assert.equal(ev._directionFix, true);
    ev.update(); assert.equal(ev._framePos, 1);
    ev.update(); ev.update(); assert.equal(ev._framePos, 0); ev.start(); assert.equal(aiCalls, 0);
    c.$gamePlayer.px = 1680; c.window.__nyaruruPhoto.facePlayer(ev); assert.equal(ev._direction, 6);
    await run(c, OPS.unpinPages());
    assert.equal(ev.py, 1248); assert.equal(ev.ry, 1248); assert.equal(ev.physics, true); assert.equal(ev.update, originalUpdate);
    const originalProbe = ev.hitPreview;
    for (const mode of ['flying', 'hazard', 'no-ground']) {
        ai.smoothfloor = mode === 'flying' ? 'false' : 'true';
        ev.hitPreview = mode === 'hazard' ? () => [{ terrain: true, type: 2 }] : mode === 'no-ground' ? () => [] : originalProbe;
        await run(c, OPS.forcePage(1, 0)); assert.equal(ev.py, 1248);
        await run(c, OPS.unpinPages());
    }
});

for (const delayed of [false, true]) test(`staging crops the sprite sheet on pin and undo (${delayed ? 'delayed' : 'cached'} bitmap)`, async () => {
    const c = gameContext();
    c.Game_Map = function() {}; c.Game_Map.prototype.setup = function() {};
    c.DataManager = { extractSaveContents() {} };
    const ev = {
        _characterName: 'original', _pageIndex: 0, _framePos: 0,
        eventId: () => 1, event: () => ({ pages: [{}, {}] }),
        characterName() { return this._characterName; },
        bitmapName() { return this._characterName + '_atlas'; },
        characterIndex: () => 0, tileId: () => 0,
        setupPageSettings() { this._characterName = 'dracula'; },
    };
    c.$gameMap.events = () => [ev]; c.$gameMap.requestRefresh = () => {};
    const images = {}, sprite = {
        _character: ev, _framePos: 0, children: [], _contentSprite: {}, updates: 0,
        setCharacterBitmap() {
            const name = this._characterName;
            const bitmap = images[name] ||= {
                width: name === 'dracula_atlas' ? 558 : 240, height: 73,
                columns: name === 'dracula_atlas' ? 6 : 3, ready: !delayed, listeners: [],
                addLoadListener(fn) { if (this.ready) fn(); else this.listeners.push(fn); },
                load() { this.ready = true; for (const fn of this.listeners.splice(0)) fn(); },
            };
            this._contentSprite.bitmap = bitmap;
            bitmap.addLoadListener(() => {
                if (this._contentSprite.bitmap === bitmap) this._contentSprite.frame = { width: bitmap.width, height: bitmap.height };
            });
        },
        updateFrame() {
            this.updates++;
            if (this._framePos === ev._framePos) return;
            this._framePos = ev._framePos;
            const bitmap = this._contentSprite.bitmap;
            this._contentSprite.frame = { width: bitmap.width / bitmap.columns, height: bitmap.height };
        },
    };
    c.SceneManager._scene.children = [sprite];
    assert.equal((await run(c, OPS.forcePage(1, 1))).ok, true);
    if (delayed) images.dracula_atlas.load();
    assert.equal(sprite._characterName, 'dracula_atlas');
    assert.deepEqual(sprite._contentSprite.frame, { width: 93, height: 73 });
    await run(c, OPS.unpinPages());
    if (delayed) images.original_atlas.load();
    assert.equal(ev.characterName(), 'original');
    assert.deepEqual(sprite._contentSprite.frame, { width: 80, height: 73 });
    if (delayed) {
        images.dracula_atlas.ready = false;
        await run(c, OPS.forcePage(1, 1));
        await run(c, OPS.unpinPages());
        const updates = sprite.updates;
        images.dracula_atlas.load(); // 旧图迟到，不能改动已撤销的显示状态。
        assert.equal(sprite.updates, updates);
        assert.deepEqual(sprite._contentSprite.frame, { width: 80, height: 73 });
    }
});

test('save awaits disk rejection instead of reporting success', async () => {
    const c = gameContext(); c.setTimeout = setTimeout;
    c.$gameSystem = { onBeforeSave() {} }; c.SceneManager.snapForBackground = () => {};
    const originalZip = () => new Promise((resolve, reject) => setTimeout(() => reject(new Error('disk full')), 5));
    c.StorageManager = { saveZip: originalZip, saveObject() { return Promise.resolve(); } };
    c.DataManager = { maxSavefiles: () => 23, saveGame() { c.StorageManager.saveZip(); return Promise.resolve(); } };
    const r = await run(c, OPS.savePhotoSlot(23)); assert.equal(r.ok, false); assert.match(r.error, /disk full/);
    assert.equal(c.StorageManager.saveZip, originalZip);
});

test('CDP shares concurrent connect, rejects pending on disconnect, ignores old socket close', async () => {
    const sockets = [];
    class WS {
        constructor() { this.readyState = 1; sockets.push(this); queueMicrotask(() => this.onopen()); }
        send(raw) {
            const p = JSON.parse(raw);
            if (p.method === 'Runtime.evaluate') return;
            const result = p.method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', targetId: 'game', url: 'chrome-extension://id/index.html' }] } : { sessionId: 'session' };
            queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: p.id, result }) }));
        }
        close() {}
    }
    const c = { module: { exports: {} }, WebSocket: WS, fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://test' }) }), AbortSignal, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/cdp.js'), 'utf8'), c);
    const client = new c.module.exports.CdpClient();
    await Promise.all([client.connect(), client.connect()]); assert.equal(sockets.length, 1);
    const old = sockets[0]; client.close(); await client.connect(); old.onclose(); assert.equal(client.ws, sockets[1]);
    const pending = client.eval('test'); await new Promise(r => setImmediate(r));
    const rejection = assert.rejects(pending, /断开/); sockets[1].onclose(); await rejection;
    assert.equal(client._pending.size, 0); client.close();
});

function serverHarness(t, ops = OPS) {
    const f = fixture(t), calls = [];
    const fake = { generation: 1, port: 9223, close() {}, async isAlive() { return false; },
        async evalJson(script) { calls.push(script); return { ok: true, gameDir: f.game, saveDir: path.join(f.game, 'save'), mapToken: 'mock:1', mapId: 1 }; } };
    const c = { __dirname: f.tool, module: { exports: {} }, process, console: { log() {}, error() {} }, URL, Buffer, setTimeout,
        require(n) {
            if (n === './lib/cdp.js') return { CdpClient: function() { return fake; } };
            if (n === './lib/ops.js') return { OPS: ops };
            if (n === './lib/story-position') return { storyPosition };
            if (n === './lib/data.js') return { loadAll: () => ({ stats: {}, triggers: [] }) };
            if (n === './lib/safety') return SAFETY;
            if (n === './lib/files') return FILES;
            if (n === './lib/processes') return { assertGamesStopped: async () => {} };
            if (n === './lib/story-cache') return require('../lib/story-cache');
            return require(n);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), c);
    c.module.exports.CONFIG.sandboxDir = f.sandbox;
    return { ...f, api: c.module.exports, fake, calls };
}
async function request(h, url, body, method = 'POST') {
    const req = new EventEmitter(); req.method = method; req.headers = {};
    let result, code;
    const res = { writeHead(c) { code = c; }, end(s) { result = JSON.parse(s); } };
    const task = h.api.handleApi(req, res, url);
    if (method === 'POST') { req.emit('data', JSON.stringify(body)); req.emit('end'); }
    await task; return { result, code };
}
test('controller stories use the verified scene entry without changing other or explicit positions', () => {
    const data = loadAll(path.resolve(__dirname, '../..'));
    for (const [story, map, expected] of [[449, 9, [11, 9]], [449, 296, [28, 13]], [467, 254, [6, 5]]]) {
        const trigger = data.triggers.find(t => t.storyId === story && t.mapId === map);
        assert.ok(trigger);
        const p = storyPosition(trigger); assert.deepEqual([p.x, p.y], expected);
    }
    // Published tests validate the structural trigger index; original map scripts are not distributed.
    for (const storyId of [298, 299, 305]) {
        const trigger = data.triggers.find(t => t.storyId === storyId && t.mapId === 182 && Number(t.eventId) === 3 && t.pageIndex === 0);
        assert.ok(trigger); assert.equal(trigger.x, 0); assert.equal(trigger.y, 0);
        const p = storyPosition(trigger);
        assert.equal(p.x, 11); assert.equal(p.y, 11); assert.ok(p.positionNote);
        for (const patch of [{ mapId: 183 }, { eventId: 4 }, { storyId: 370 }, { pageIndex: 1 }, { pageIndex: null }, { x: 7, y: 8 }, { x: null }]) {
            const input = { ...trigger, ...patch };
            assert.deepEqual(storyPosition(input), { x: input.x, y: input.y });
        }
    }
});

test('unknown controller scenes preserve safe positions or find floor without story-number rules', () => {
    const actor = { _x: 6, _y: 7, eventId: () => 2, characterName: () => 'actor', event: () => ({ pages: [] }) };
    const page = { trigger: 3, image: { characterName: '', tileId: 0 }, list: [] };
    let probes = 0, hazard = false, noFloor = false;
    const player = { _x: 0, _y: 0, hitPreview(dx, dy) {
        probes++; if (noFloor || dy < 8 * 96) return [];
        return [{ terrain: true, type: hazard && dx === 5 * 96 ? 2 : 0 }];
    } };
    const input = { map: { tileWidth: () => 96, tileHeight: () => 96, width: () => 20, height: () => 15, events: () => [actor] },
        player, data: { events: [null, { x: 0, y: 0, pages: [page] }] }, eventId: 1, pageIndex: 0,
        storyId: 987654, sameMap: true, previous: { x: 10, y: 7 }, requested: { x: 0, y: 0 } };
    let r = chooseStoryPosition(input); assert.equal(r.x, 10); assert.equal(r.y, 7);
    input.sameMap = false; hazard = true;
    r = chooseStoryPosition(input); assert.equal(r.x, 7); assert.equal(r.y, 7); // 左侧陷阱被拒绝，选右侧。
    page.trigger = 4; r = chooseStoryPosition(input); assert.equal(r.controller, true);
    noFloor = true; probes = 0; r = chooseStoryPosition(input);
    assert.equal(r.ok, false); assert.match(r.error, /未找到/); assert.ok(probes <= 800);
    page.trigger = 0; probes = 0; r = chooseStoryPosition(input);
    assert.equal(r.controller, false); assert.equal(r.x, 0); assert.equal(probes, 0);
    page.trigger = 3; page.image.characterName = 'visible';
    assert.equal(chooseStoryPosition(input).controller, false); // 有形事件不能当成控制事件。
});

test('scene, dialogue and goto APIs correct stale controller coordinates before teleport', async t => {
    const targets = [], order = [];
    const h = serverHarness(t, { ...OPS,
        teleport(x, y, options) { targets.push({ x, y, map: options.mapId }); return OPS.teleport(x, y, options); },
        runStoryScene(...args) { order.push('scene'); return OPS.runStoryScene(...args); },
        land() { order.push('land'); return OPS.land(); },
    });
    const body = { context: '1:mock:1', mapId: 182, eventId: 3, pageIndex: 0, storyId: 305, x: 0, y: 0 };
    await request(h, '/api/story/start', { ...body, mode: 'scene' });
    await request(h, '/api/story/start', { ...body, mode: 'play' });
    await request(h, '/api/story/goto', { ...body, pairs: [] });
    assert.deepEqual(order, ['scene', 'land']); // 只对运行过场自动落地，且在补角色之后。
    assert.deepEqual(targets, Array.from({ length: 3 }, () => ({ x: 11, y: 11, map: 182 })));
    await request(h, '/api/story/start', { ...body, mode: 'play', x: 7, y: 8 });
    assert.deepEqual(targets[3], { x: 7, y: 8, map: 182 });
});

test('restore never defaults to original; GET cannot mutate', async t => {
    const h = serverHarness(t);
    await assert.rejects(request(h, '/api/restore-backup', { name: 'any', confirm: true }), /明确/);
    assert.equal((await request(h, '/api/restore', null, 'GET')).code, 405);
    assert.equal(h.calls.length, 0);
});
test('photo save checks target and blocks both stale context and backup failure', async t => {
    const h = serverHarness(t);
    await assert.rejects(request(h, '/api/save-photo', { context: '1:mock:1', slot: 23, target: 'sandbox' }), /不一致/);
    await assert.rejects(request(h, '/api/save-photo', { context: '1:old', slot: 23, target: 'original' }), /已变化/);
    fs.unlinkSync(path.join(h.game, 'save', 'file1.rmmzsave')); fs.unlinkSync(path.join(h.game, 'save', 'global.rmmzsave'));
    await assert.rejects(request(h, '/api/save-photo', { context: '1:mock:1', slot: 23, target: 'original' }), /没有找到/);
    assert.equal(h.calls.some(s => s.includes('await DataManager.saveGame(s)')), false);
});
test('mutations are serialized and stale map-local actions are rejected', async t => {
    const h = serverHarness(t); let active = 0, max = 0;
    h.fake.evalJson = async s => {
        if (!s.includes('const i=JSON.parse')) return { ok: true, gameDir: h.game, saveDir: path.join(h.game, 'save'), mapToken: 'mock:1' };
        active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 10)); active--; return { ok: true };
    };
    await Promise.all([request(h, '/api/gravity', { context: '1:mock:1', on: true }), request(h, '/api/gravity', { context: '1:mock:1', on: false })]);
    assert.equal(max, 1);
    await assert.rejects(request(h, '/api/events/force-page', { context: '1:old-map', eventId: 1, page: 0 }), /已变化/);
});
test('public structural index excludes text and preserves distinct event/page alternatives', () => {
    const data = loadAll(path.resolve(__dirname, '../..'));
    assert.ok(data.triggers.length > 0);
    assert.ok(data.triggers.every(t => !('lines' in t) && !('line' in t) && !('searchText' in t)));
    assert.equal(data.storyIndex, undefined);
    const story11 = data.triggers.filter(t => t.storyId === 11);
    assert.ok(new Set(story11.map(t => t.page)).size > 1);
});

function launcherHarness(t, { ready = false, choice = '3', occupied = false, identityError = false, backupError = false } = {}) {
    const f = fixture(t), actions = [];
    fs.writeFileSync(path.join(f.tool, 'config.json'), JSON.stringify({ sandboxDir: f.sandbox }));
    const c = { __dirname: f.tool, module: { exports: {} }, console: { log() {} }, setTimeout,
        process: { versions: { node: '24.0.0' }, argv: [], stdin: {}, stdout: {}, execPath: process.execPath },
        require(n) {
            if (n === './lib/safety') return SAFETY;
            if (n === './lib/files') return { sandboxStatus: () => ({ ready, reason: 'mock' }), backupSaves: () => { actions.push('backup'); if (backupError) throw Error('backup failed'); return { name: 'mock' }; } };
            if (n === './lib/cdp') return { CdpClient: function() { return { close() {}, async evalJson() { if (identityError) throw Error('unknown'); return { ok: true, gameDir: f.game, saveDir: path.join(f.game, 'save') }; } }; } };
            if (n === './lib/ops') return { OPS };
            if (n === 'readline/promises') return { createInterface: () => ({ question: async () => choice, close() {} }) };
            if (n === 'net') return { connect: ({ port }) => { const s = new EventEmitter(); s.destroy = () => {}; s.setTimeout = () => {}; queueMicrotask(() => s.emit(occupied && port === 9223 ? 'connect' : 'error')); return s; } };
            if (n === 'child_process') return { spawn: () => { actions.push('spawn'); throw Error('unexpected spawn'); } };
            return require(n);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../launcher.js'), 'utf8'), c);
    return { main: c.module.exports.main, actions };
}
test('launcher exit stops completely, wrong and unknown instances stop before backup/panel', async t => {
    const exit = launcherHarness(t); await exit.main(); assert.deepEqual(exit.actions, []);
    for (const identityError of [false, true]) {
        const h = launcherHarness(t, { ready: true, occupied: true, identityError });
        await assert.rejects(h.main(), /不能确认/); assert.deepEqual(h.actions, []);
    }
});
test('launcher backup failure prevents starting either game or panel', async t => {
    const h = launcherHarness(t, { ready: true, backupError: true });
    await assert.rejects(h.main(), /backup failed/); assert.deepEqual(h.actions, ['backup']);
});
test('panel save warning lets the user continue or cancel using the existing confirmation', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
    const start = source.indexOf("$('#photo-save').onclick");
    const end = source.indexOf('// ---------- 对话跳转点', start);
    for (const proceed of [false, true]) {
        const button = {}, calls = []; let confirmation;
        vm.runInNewContext(source.slice(start, end), {
            $: key => key === '#photo-save' ? button : { value: '23' },
            CURRENT_CONTEXT: 'current', CURRENT_GAME: { kind: 'sandbox', saveDir: 'sandbox/save' },
            confirm: text => { confirmation = text; return proceed; },
            api: async (route, body) => { calls.push({ route, body }); return { ok: true, slot: 23 }; },
            toast() {}, loadBackups() {},
        });
        await button.onclick();
        assert.match(confirmation, /不推荐.*保存/); assert.match(confirmation, /仍可确定继续保存/);
        assert.equal(calls.length, proceed ? 1 : 0);
        if (proceed) { assert.equal(calls[0].route, '/save-photo'); assert.equal(calls[0].body.slot, 23); assert.equal(calls[0].body.target, 'sandbox'); }
    }
});

test('map event search matches later lines and displays the matched text', () => {
    const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
    const start = source.indexOf('function renderEvents()');
    const end = source.indexOf("$('#ev-load').onclick", start);
    const list = { innerHTML: '', querySelectorAll: () => [] };
    const elements = { '#ev-filter': { value: 'later sentence' }, '#ev-all': { checked: false }, '#ev-list': list };
    vm.runInNewContext(source.slice(start, end) + ';renderEvents();', {
        $: key => elements[key], esc: value => String(value), spriteLabel: () => '',
        EVENTS: [{ id: 1, hasStory: true, name: 'event', sprite: '', trigger: 'test', x: 0, y: 0,
            lines: [{ first: 'first sentence', speaker: 'actor', searchText: 'first sentence\nlater sentence', lines: [{ text: 'first sentence', speaker: 'actor' }, { text: 'later sentence', speaker: 'actor' }] }] }],
    });
    assert.match(list.innerHTML, /later sentence/); assert.doesNotMatch(list.innerHTML, /没有匹配|没有带剧情/);
});
