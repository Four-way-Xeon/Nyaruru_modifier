// 启动器与服务端共用的路径、配置校验。
const fs = require('fs');
const path = require('path');

function canonical(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('必须填写绝对路径');
    let p = path.resolve(input);
    const tail = [];
    while (!fs.existsSync(p)) {
        const parent = path.dirname(p);
        if (parent === p) throw new Error('目录所在磁盘不存在');
        tail.unshift(path.basename(p)); p = parent;
    }
    return path.join(fs.realpathSync.native(p), ...tail);
}
function samePath(a, b) { return canonical(a).toLowerCase() === canonical(b).toLowerCase(); }
function contains(a, b) {
    const rel = path.relative(canonical(a).toLowerCase(), canonical(b).toLowerCase());
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function validateConfig(config, gameDir) {
    const next = { ...config };
    for (const key of ['cdpPort', 'webPort']) {
        const n = Number(next[key]);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${key} 必须是 1024~65535 的整数`);
        next[key] = n;
    }
    if (next.cdpPort === next.webPort) throw new Error('游戏调试端口和控制面板端口不能相同');
    next.sandboxDir = canonical(String(next.sandboxDir || '').trim());
    if (contains(gameDir, next.sandboxDir) || contains(next.sandboxDir, gameDir)) {
        throw new Error('沙盒与原版目录必须完全分开，不能相同，也不能互相包含');
    }
    return next;
}
function readConfig(file, defaults, gameDir) {
    let patch = {};
    if (fs.existsSync(file)) {
        try { patch = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { throw new Error('config.json 损坏，请修正配置后重试；不会静默换用其他目录'); }
    }
    return validateConfig({ ...defaults, ...patch }, gameDir);
}
module.exports = { canonical, samePath, contains, validateConfig, readConfig };
