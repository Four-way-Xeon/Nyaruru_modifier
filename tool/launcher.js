const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const readline = require('readline/promises');
const { readConfig, samePath } = require('./lib/safety');
const FILES = require('./lib/files');
const { CdpClient } = require('./lib/cdp');
const { OPS } = require('./lib/ops');
const TOOL = __dirname, AITEMP = path.dirname(TOOL), GAME = path.dirname(AITEMP);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function listening(port) {
    return new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port });
        const finish = yes => { s.destroy(); resolve(yes); };
        s.once('connect', () => finish(true)); s.once('error', () => finish(false)); s.setTimeout(1000, () => finish(false));
    });
}
async function panel(config, matchConfig = true) {
    const r = await fetch(`http://127.0.0.1:${config.webPort}/api/health`, { signal: AbortSignal.timeout(1500) });
    const data = await r.json();
    if (!r.ok || data.version !== 2 || !data.toolDir || !samePath(data.toolDir, TOOL) || (matchConfig && JSON.stringify(data.config) !== JSON.stringify(config))) {
        throw new Error('面板端口运行的是旧服务、其他版本或旧配置。请先关闭那个面板服务，再重新启动');
    }
    return data;
}
async function main() {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本');
    const config = readConfig(path.join(TOOL, 'config.json'), { cdpPort: 9223, sandboxDir: path.join(path.parse(GAME).root, 'Nyaruru_shots'), webPort: 8787 }, GAME);
    if (process.argv.includes('--stop')) {
        const runtimeFile = path.join(TOOL, '.server-runtime.json');
        const port = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).port : config.webPort;
        await panel({ ...config, webPort: port }, false);
        await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        console.log('控制面板服务已停止，游戏窗口保留'); return;
    }
    const runtimeFile = path.join(TOOL, '.server-runtime.json');
    if (fs.existsSync(runtimeFile)) {
        const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
        if (runtime.port !== config.webPort && await listening(runtime.port)) {
            await panel({ ...config, webPort: runtime.port }, false);
            throw new Error('旧面板仍在原端口运行，请先双击“停止面板.bat”，再重新启动');
        }
    }
    console.log('咸鱼喵喵 · 截图辅助工具\n调试端口 ' + config.cdpPort + ' / 面板端口 ' + config.webPort);
    const panelRunning = await listening(config.webPort);
    if (panelRunning) await panel(config);
    const status = FILES.sandboxStatus(GAME, config.sandboxDir, AITEMP);
    let target = status.ready ? config.sandboxDir : null;
    if (!status.ready) {
        console.log('沙盒尚不可用：' + status.reason + '\n[1] 只启动面板，创建沙盒\n[2] 启动原版游戏\n[3] 退出');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let choice; try { choice = (await rl.question('请选择（默认 1）：')).trim(); } finally { rl.close(); }
        if (choice === '3') { console.log('已退出'); return; }
        if (choice === '2') target = GAME;
        else if (choice && choice !== '1') throw new Error('无效选择，已退出');
    }
    if (target) {
        const occupied = await listening(config.cdpPort);
        if (occupied) {
            const client = new CdpClient(config.cdpPort);
            try {
                const info = await client.evalJson(OPS.selfPath());
                if (!info.ok || !info.gameDir || !samePath(info.gameDir, target) || !info.saveDir || !samePath(info.saveDir, path.join(target, 'save'))) {
                    throw new Error('调试端口上的游戏与目标不符。期望：' + target + '；实际：' + (info.gameDir || '未知'));
                }
            } catch (e) { throw new Error('未启动面板：不能确认已有游戏实例。' + e.message); }
            finally { client.close(); }
        }
        const backup = FILES.backupSaves(path.join(AITEMP, 'backups'), target, samePath(target, GAME) ? 'original' : 'sandbox');
        console.log('存档已备份并校验：' + backup.name);
        if (!occupied) {
            const nw = path.join(AITEMP, 'nwjs-sdk-v0.64.1-win-x64', 'nw.exe');
            if (!fs.existsSync(nw)) throw new Error('缺少 SDK 版 NW.js 0.64.1：' + nw + '\n下载：https://dl.nwjs.io/v0.64.1/nwjs-sdk-v0.64.1-win-x64.zip');
            const child = spawn(nw, [target, '--remote-debugging-port=' + config.cdpPort], { cwd: path.dirname(nw), detached: true, stdio: 'ignore', windowsHide: true });
            await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
            const client = new CdpClient(config.cdpPort);
            let ready = false;
            try {
                for (let i = 0; i < 20; i++) {
                    try {
                        const info = await client.evalJson(OPS.selfPath());
                        if (!info.ok || !info.gameDir || !samePath(info.gameDir, target) || !info.saveDir || !samePath(info.saveDir, path.join(target, 'save'))) throw new Error('实际游戏路径不符');
                        ready = true; break;
                    } catch { client.close(); await sleep(500); }
                }
            } finally { client.close(); }
            if (!ready) throw new Error('游戏未能就绪或实例身份不符，未启动面板。请检查游戏窗口');
        }
        console.log('当前游戏：' + target);
    }
    if (!panelRunning) {
        const log = fs.openSync(path.join(TOOL, 'server.log'), 'a');
        const child = spawn(process.execPath, [path.join(TOOL, 'server.js')], { cwd: TOOL, detached: true, stdio: ['ignore', log, log], windowsHide: true });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref(); fs.closeSync(log);
        let ready = false;
        for (let i = 0; i < 20; i++) { try { await panel(config); ready = true; break; } catch { await sleep(300); } }
        if (!ready) throw new Error('面板启动失败，请查看 tool/server.log');
    }
    const url = `http://127.0.0.1:${config.webPort}`;
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log('请手动打开：' + url)); browser.unref();
    console.log('面板已就绪：' + url + (target ? '' : '\n本次没有启动游戏。创建沙盒后再次运行启动.bat'));
}
if (require.main === module) main().catch(e => { console.error('\n启动停止：' + e.message); process.exitCode = 1; });
module.exports = { main, listening, panel };
