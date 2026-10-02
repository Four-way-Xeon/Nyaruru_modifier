// 与启动器、服务端一致：读取实际游戏及存档目录，不解析页面 URL。
const { CdpClient } = require('./cdp');
const { OPS } = require('./ops');
async function probe(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效');
    const c = new CdpClient(port);
    try { const r = await c.evalJson(OPS.selfPath()); if (!r.ok || !r.gameDir) throw new Error(r.error || '无法识别游戏'); return r; }
    finally { c.close(); }
}
if (require.main === module) probe(Number(process.argv[2])).then(r => console.log(r.gameDir)).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { probe };
