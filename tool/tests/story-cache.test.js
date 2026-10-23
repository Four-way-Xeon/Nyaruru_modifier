const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { StoryCache } = require('../lib/story-cache');
const { OPS } = require('../lib/ops');

function fixture(options = {}) {
    let calls = 0;
    const cdp = { port: 9223, generation: 1, sessionId: 'session-1', ws: { readyState: 1 },
        async isAlive() { return true; }, async connect() { this.ws = { readyState: 1 }; },
        async evalJson() { calls++; return { ok: true, index: { 1: { first: 'fixture', lines: [{ text: 'fixture' }] } } }; } };
    const cache = new StoryCache(cdp, OPS, [{ storyId: 1 }, { storyId: 2 }], options);
    return { cdp, cache, calls: () => calls };
}

test('runtime story index searches later synthetic lines and excludes commands and comments', async () => {
    const context = vm.createContext({ $dataActors: { 2: { name: '模拟角色' } }, $dataStory: {
        1: [{ name: 'story', contents: '模拟首句', speaker: 2 }, { name: 'story', contents: '模拟后续检索句' },
            { name: 'story', contents: '#注释' }, { name: 'story', contents: '///备注' }, { name: 'other', contents: '不属于台词' }],
        2: [{ name: 'story', contents: '   ' }], invalid: [{ name: 'story', contents: '忽略' }],
    } });
    const result = JSON.parse(await vm.runInContext(OPS.readStoryIndex(), context));
    assert.equal(result.ok, true); assert.equal(result.count, 1);
    assert.equal(result.index[1].count, 2); assert.equal(result.index[1].speaker, '模拟角色');
    assert.match(result.index[1].searchText, /模拟后续检索句/);
    assert.doesNotMatch(result.index[1].searchText, /注释|备注|不属于台词/);
});

test('story cache shares reads, clears disconnected text and reloads a new connection', async () => {
    const f = fixture();
    await Promise.all([f.cache.ensure(), f.cache.ensure()]);
    assert.equal(f.calls(), 1); assert.equal(f.cache.status().triggersWithLine, 1);
    f.cdp.ws = null; assert.equal(f.cache.get(1), null); assert.equal(f.cache.status().state, 'disconnected');
    f.cdp.generation++; f.cdp.sessionId = 'session-2'; await f.cache.ensure();
    assert.equal(f.calls(), 2); assert.equal(f.cache.status().loaded, true);
});

test('story cache rate limits four retries and permits explicit retry after failure', async () => {
    let now = 0; const f = fixture({ now: () => now });
    f.cdp.evalJson = async () => ({ ok: false, error: 'fixture not ready' });
    await f.cache.ensure(); await f.cache.ensure(); assert.equal(f.cache.status().attempts, 1);
    for (let i = 0; i < 3; i++) { now += 3000; await f.cache.ensure(); }
    now += 3000; await f.cache.ensure();
    assert.equal(f.cache.status().attempts, 4); assert.equal(f.cache.status().state, 'error');
    f.cdp.evalJson = async () => ({ ok: true, index: { 1: { first: 'ready' } } });
    await f.cache.ensure({ force: true }); assert.equal(f.cache.get(1).first, 'ready');
});

test('late story response from an old connection cannot overwrite new text', async () => {
    const f = fixture(); let resolve;
    f.cdp.evalJson = () => new Promise(r => { resolve = r; });
    const old = f.cache.ensure();
    f.cdp.generation++; f.cdp.sessionId = 'session-2'; f.cache.status();
    f.cdp.evalJson = async () => ({ ok: true, index: { 1: { first: 'new connection' } } });
    await f.cache.ensure(); resolve({ ok: true, index: { 1: { first: 'stale connection' } } }); await old;
    assert.equal(f.cache.get(1).first, 'new connection');
});
