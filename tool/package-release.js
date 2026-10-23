// Explicit allow-list packaging. Never copy the working tree recursively.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');

function manifestFiles(root = ROOT) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tool/发布清单.json'), 'utf8'));
    const files = manifest.files;
    if (!Array.isArray(files) || new Set(files).size !== files.length) throw Error('发布清单无效或包含重复文件');
    for (const file of files) {
        if (typeof file !== 'string' || file.includes('\\') || path.posix.isAbsolute(file) || file.split('/').some(p => !p || p === '.' || p === '..')) throw Error('发布路径无效：' + file);
        if (/^(?:out|unpacked)\//.test(file) && !['out/triggers.csv', 'unpacked/data/System.json', 'unpacked/data/MapInfos.json'].includes(file)) throw Error('原始游戏数据不能打包：' + file);
        if (/(?:^|\/)(?:\.git|config\.json|\.server-runtime\.json|backups|save|probe|docs\/历史|nwjs-sdk[^/]*)(?:\/|$)|\.(?:rmmzsave|bin|log|zip)$/i.test(file)) throw Error('私人或运行时文件不能打包：' + file);
        let current = root;
        for (const part of file.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw Error('不能打包链接：' + file); }
        if (!fs.statSync(current).isFile()) throw Error('发布项不是文件：' + file);
    }
    return files;
}

function buildRelease(destination = path.join(ROOT, 'dist', 'Nyaruru_modifier'), root = ROOT) {
    destination = path.resolve(destination);
    const files = manifestFiles(root);
    if (fs.existsSync(destination)) throw Error('输出目录已存在，请使用新的空路径：' + destination);
    fs.mkdirSync(destination, { recursive: true });
    const hashes = [];
    for (const file of files) {
        const target = path.join(destination, file), data = fs.readFileSync(path.join(root, file));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data, { flag: 'wx' });
        hashes.push({ file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    }
    return { destination, files: hashes };
}

if (require.main === module) {
    try { const result = buildRelease(process.argv[2]); console.log(JSON.stringify(result, null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildRelease, manifestFiles };
