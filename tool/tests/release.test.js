const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildRelease, manifestFiles } = require('../package-release');

function tempRoot(t) {
    const parent = fs.realpathSync.native(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'nyaruru-public-release-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(root)), parent);
        assert.match(path.basename(root), /^nyaruru-public-release-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}
function walk(root, prefix = '') {
    return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        return entry.isDirectory() ? walk(root, relative) : [relative];
    });
}

test('clean release contains only allow-listed files and serves its page without game access', async t => {
    const root = tempRoot(t), destination = path.join(root, 'Nyaruru_modifier');
    const result = buildRelease(destination);
    assert.deepEqual(walk(destination).sort(), manifestFiles().sort());
    assert.equal(result.files.length, manifestFiles().length);
    assert.throws(() => buildRelease(destination), /已存在/);
    const mod = require(path.join(destination, 'tool/server.js'));
    let gameCalls = 0;
    for (const method of ['connect', 'evalJson', 'isAlive']) mod.cdp[method] = async () => { gameCalls++; throw Error('No live game access in release tests'); };
    await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { mod.server.closeAllConnections(); mod.server.close(resolve); }));
    const origin = 'http://127.0.0.1:' + mod.server.address().port;
    const health = await fetch(origin + '/api/health').then(r => r.json());
    assert.equal(health.ok, true); assert.equal(health.config.webPort, 8787);
    const html = await fetch(origin).then(r => r.text());
    for (const id of ['story-text-hint', 'story-load-text', 'panel-world-map', 'panel-encyclopedia']) assert.ok(html.includes('id="' + id + '"'));
    assert.equal((await fetch(origin + '/app.js')).status, 200);
    assert.equal(gameCalls, 0);
    assert.doesNotMatch(html, /panel-workspace|data-panel="workspace"|快照与 TAS/);
    for (const route of ['/api/checkpoints','/api/tas']) assert.equal((await fetch(origin + route)).status, 405);
    const app = await fetch(origin + '/app.js').then(r => r.text());
    assert.doesNotMatch(app, /loadWorkspace|WORK_BUSY|panel-workspace|checkpoints|\/tas/);
    const { OPS } = require(path.join(destination, 'tool/lib/ops.js'));
    for (const name of ['tas','captureCheckpoint','loadCheckpoint','restoreCheckpointTools']) assert.equal(OPS[name], undefined);
    assert.equal(typeof OPS.snapshot, 'function'); assert.equal(typeof OPS.combat, 'function');
    assert.deepEqual(walk(destination).sort(), manifestFiles().sort());
});

test('release manifest rejects raw maps, runtime configuration and path traversal', t => {
    const root = tempRoot(t); fs.mkdirSync(path.join(root, 'tool'));
    for (const file of ['unpacked/data/Map181.json', 'out/story.json', 'tool/config.json', '../outside', 'backups/states.bin']) {
        fs.writeFileSync(path.join(root, 'tool/发布清单.json'), JSON.stringify({ files: [file] }));
        assert.throws(() => manifestFiles(root));
    }
});
