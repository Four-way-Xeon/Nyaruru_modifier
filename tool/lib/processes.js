const { execFile } = require('child_process');
async function assertGamesStopped() {
    if (process.platform !== 'win32') throw new Error('当前平台无法核实游戏进程，停止还原');
    const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match "^(nw|Nyaruru).*\\.exe$" } | Select-Object ProcessId,Name) | ConvertTo-Json -Compress';
    const text = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 6000, encoding: 'utf8' }, (e, out) => e ? reject(new Error('无法检查游戏进程，停止还原：' + e.message)) : resolve(out)));
    const rows = text.trim() ? JSON.parse(text) : [];
    if ((Array.isArray(rows) ? rows : [rows]).length) throw new Error('请先退出游戏及 NW.js 游戏窗口，再还原存档，避免运行中的游戏把旧状态写回');
}
module.exports = { assertGamesStopped };
