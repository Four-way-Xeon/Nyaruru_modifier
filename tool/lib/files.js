const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { canonical, samePath, contains } = require('./safety');
const MANIFEST = 'backup-manifest.json';
const COMPLETE = '.nyaruru-sandbox-complete.json';
const INCOMPLETE = '.nyaruru-sandbox-incomplete';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const saveNames = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /\.rmmzsave$/i.test(n)).sort() : [];
function safeFile(dir, name) {
    if (path.basename(name) !== name || !/\.rmmzsave$/i.test(name)) throw new Error('非法存档文件名');
    const file = path.join(dir, name), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('存档必须是普通文件：' + name);
    return file;
}
function backupSaves(root, sourceDir, label = 'auto') {
    const saveDir = path.join(canonical(sourceDir), 'save');
    if (!fs.existsSync(saveDir) || !samePath(saveDir, path.join(sourceDir, 'save')) || fs.lstatSync(saveDir).isSymbolicLink()) throw new Error('存档目录不存在或是目录链接');
    const names = saveNames(saveDir);
    if (!names.length) throw new Error('没有找到 .rmmzsave 存档，未创建空备份');
    fs.mkdirSync(root, { recursive: true });
    const dest = fs.mkdtempSync(path.join(root, `${label.replace(/[^a-z0-9_-]/gi, '')}_${new Date().toISOString().replace(/[:.]/g, '-')}_`));
    // 未完成目录没有 manifest，不会被列为可恢复备份。
    const files = names.map(name => ({ name, sha256: hash(safeFile(saveDir, name)) }));
    for (const f of files) fs.copyFileSync(safeFile(saveDir, f.name), path.join(dest, f.name), fs.constants.COPYFILE_EXCL);
    if (JSON.stringify(names) !== JSON.stringify(saveNames(saveDir)) || files.some(f => hash(safeFile(saveDir, f.name)) !== f.sha256 || hash(path.join(dest, f.name)) !== f.sha256)) {
        throw new Error('备份期间存档发生变化或复制校验失败，请停止存档操作后重试。未完成目录：' + dest);
    }
    const manifest = { version: 1, sourceDir: canonical(sourceDir), createdAt: new Date().toISOString(), files };
    fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return { dir: dest, name: path.basename(dest), files: files.length, from: saveDir };
}
function inspectBackup(root, name) {
    if (typeof name !== 'string' || name === '.' || name === '..' || /[\\/:]/.test(name)) throw new Error('非法备份名');
    const dir = path.join(root, name);
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw new Error('备份不存在或是目录链接');
    let manifest = null;
    const meta = path.join(dir, MANIFEST);
    if (fs.existsSync(meta)) {
        manifest = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('备份清单无效');
    } else if (!/^\d{8}_\d{6}$|^[a-z][a-z0-9_-]*_\d{8}_\d{6}$/i.test(name)) {
        throw new Error('备份没有完成标记');
    }
    const files = manifest ? manifest.files : saveNames(dir).map(name => ({ name }));
    if (!files.length || new Set(files.map(f => f.name)).size !== files.length) throw new Error('备份为空或文件重复');
    for (const f of files) {
        const digest = hash(safeFile(dir, f.name));
        if (f.sha256 && digest !== f.sha256) throw new Error('备份内容校验失败：' + f.name);
        f.sha256 = digest;
    }
    return { dir, manifest, files };
}
function listBackups(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).flatMap(name => {
        try {
            const b = inspectBackup(root, name);
            return [{ name, files: b.files.length, sourceDir: b.manifest?.sourceDir || null, legacy: !b.manifest, mtime: fs.statSync(b.dir).mtimeMs }];
        } catch { return []; }
    }).sort((a, b) => b.mtime - a.mtime);
}
function restoreBackup(root, name, targetDir) {
    const b = inspectBackup(root, name);
    const target = canonical(targetDir), saveDir = path.join(target, 'save');
    if (fs.existsSync(saveDir) && fs.lstatSync(saveDir).isSymbolicLink()) throw new Error('不能还原到存档目录链接');
    const safety = saveNames(saveDir).length ? backupSaves(root, target, 'prerestore') : null;
    const stage = fs.mkdtempSync(path.join(target, '.save-restore-'));
    // 保留云配置等非存档文件；存档集合严格来自选中的备份。
    if (fs.existsSync(saveDir)) {
        for (const entry of fs.readdirSync(saveDir, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || entry.isDirectory()) throw new Error('存档目录含链接或子目录，停止还原');
            if (!/\.rmmzsave$/i.test(entry.name)) fs.copyFileSync(path.join(saveDir, entry.name), path.join(stage, entry.name));
        }
    }
    for (const f of b.files) {
        fs.copyFileSync(path.join(b.dir, f.name), path.join(stage, f.name));
        if (hash(path.join(stage, f.name)) !== f.sha256) throw new Error('还原暂存校验失败');
    }
    const old = path.join(target, `.save-before-restore-${crypto.randomUUID()}`);
    const hadSave = fs.existsSync(saveDir);
    if (hadSave) fs.renameSync(saveDir, old);
    try { fs.renameSync(stage, saveDir); }
    catch (e) { if (hadSave) fs.renameSync(old, saveDir); throw e; }
    return { restored: b.files.length, target: saveDir, safetyBackup: safety?.name || null, previousDirectory: hadSave ? old : null };
}
function excludedDirs(gameDir, toolDir) {
    return fs.readdirSync(gameDir, { withFileTypes: true }).filter(e => e.isDirectory() && (
        /^aitemp/i.test(e.name) || samePath(path.join(gameDir, e.name), toolDir) || fs.existsSync(path.join(gameDir, e.name, 'tool', 'server.js'))
    )).map(e => path.join(gameDir, e.name));
}
function gameFiles(gameDir, excluded) {
    const result = [];
    function walk(dir, prefix = '') {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, e.name), rel = path.join(prefix, e.name);
            if (!prefix && (['save', 'error', 'debug.log'].includes(e.name.toLowerCase()) || /^aitemp/i.test(e.name) || e.name.startsWith('.save-') || excluded.some(d => samePath(d, file)))) continue;
            if (e.isSymbolicLink()) throw new Error('游戏目录含链接，无法验证完整副本：' + rel);
            if (e.isDirectory()) walk(file, rel);
            else if (e.isFile()) result.push({ name: rel, size: fs.statSync(file).size });
        }
    }
    walk(gameDir); return result;
}
function sandboxStatus(gameDir, sandboxDir, toolDir, checkingCopy = false) {
    try {
        if (contains(gameDir, sandboxDir) || contains(sandboxDir, gameDir)) return { ready: false, reason: '沙盒路径与原版重叠' };
        if (!fs.existsSync(sandboxDir)) return { ready: false, reason: '尚未创建' };
        if (!checkingCopy && fs.existsSync(path.join(sandboxDir, INCOMPLETE))) return { ready: false, reason: '上次复制尚未完成，请另选空目录重新创建' };
        const required = gameFiles(gameDir, excludedDirs(gameDir, toolDir));
        if (!required.some(f => f.name === 'package.json') || !required.some(f => f.name === 'index.html')) throw new Error('原版游戏目录不完整');
        const bad = required.find(f => {
            const dest = path.join(sandboxDir, f.name);
            return !fs.existsSync(dest) || !fs.statSync(dest).isFile() || fs.statSync(dest).size !== f.size || !contains(sandboxDir, canonical(dest));
        });
        if (bad) return { ready: false, reason: '副本缺失或大小不符：' + bad.name };
        return { ready: true, legacy: !fs.existsSync(path.join(sandboxDir, COMPLETE)), files: required.length };
    } catch (e) { return { ready: false, reason: e.message }; }
}
function copySandbox(gameDir, sandboxDir, toolDir) {
    if (contains(gameDir, sandboxDir) || contains(sandboxDir, gameDir)) throw new Error('沙盒路径与原版重叠');
    if (fs.existsSync(sandboxDir) && fs.readdirSync(sandboxDir).length) throw new Error('目标目录非空，不能覆盖；请选择新的空目录');
    const excluded = excludedDirs(gameDir, toolDir);
    const originalSave = path.join(gameDir, 'save');
    const saves = saveNames(originalSave).map(name => ({ name, sha256: hash(safeFile(originalSave, name)) }));
    if (!saves.length) throw new Error('原版没有存档，请先正常开始游戏并保存');
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(path.join(sandboxDir, INCOMPLETE), new Date().toISOString(), { flag: 'wx' });
    return new Promise((resolve, reject) => {
        execFile('robocopy', [gameDir, sandboxDir, '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/XF', 'aitemp*', 'debug.log', '/XD', ...excluded, 'error', '.save-*'],
            { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out, stderr) => {
                try {
                    if (err && !(Number.isInteger(err.code) && err.code <= 7 && err.code >= 0)) throw new Error(stderr || err.message);
                    const status = sandboxStatus(gameDir, sandboxDir, toolDir, true);
                    if (!status.ready) throw new Error(status.reason);
                    if (JSON.stringify(saveNames(originalSave)) !== JSON.stringify(saves.map(f => f.name)) || saves.some(f => hash(safeFile(originalSave, f.name)) !== f.sha256 || hash(safeFile(path.join(sandboxDir, 'save'), f.name)) !== f.sha256)) throw new Error('复制期间存档发生变化或副本校验失败，请退出游戏后重建');
                    fs.writeFileSync(path.join(sandboxDir, COMPLETE), JSON.stringify({ createdAt: new Date().toISOString(), files: status.files }));
                    fs.unlinkSync(path.join(sandboxDir, INCOMPLETE));
                    resolve(status);
                } catch (e) { reject(e); }
            });
    });
}
module.exports = { backupSaves, listBackups, restoreBackup, inspectBackup, sandboxStatus, copySandbox, excludedDirs };
