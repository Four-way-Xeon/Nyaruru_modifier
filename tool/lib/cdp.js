// 单连接 CDP 客户端，要求 Node.js 22+（内置 fetch / WebSocket）。
const RECONNECT_DELAY_MS = 3000;
class CdpClient {
    constructor(port = 9223) {
        this.port = port; this.ws = null; this.sessionId = null;
        this._id = 0; this._pending = new Map(); this._connecting = null; this.generation = 0;
    }
    get base() { return `http://127.0.0.1:${this.port}`; }
    async isAlive() {
        try {
            const r = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(1500) });
            return r.ok && !!(await r.json()).webSocketDebuggerUrl;
        } catch { return false; }
    }
    connect() {
        if (this.ws?.readyState === 1 && this.sessionId) return Promise.resolve();
        if (this._connecting) return this._connecting;
        const generation = ++this.generation;
        const attempt = this._connect(generation);
        this._connecting = attempt;
        attempt.finally(() => { if (this._connecting === attempt) this._connecting = null; }).catch(() => {});
        return attempt;
    }
    async _connect(generation) {
        let ws;
        try {
            const r = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(3000) });
            if (!r.ok) throw new Error('调试端口没有返回 CDP 信息');
            const v = await r.json();
            if (this.generation !== generation) throw new Error('连接已取消');
            ws = new WebSocket(v.webSocketDebuggerUrl);
            this.ws = ws;
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { reject(new Error('连接游戏超时')); try { ws.close(); } catch {} }, 4000);
                const fail = () => { clearTimeout(timer); reject(new Error('无法建立游戏调试连接')); };
                ws.onopen = () => { clearTimeout(timer); resolve(); };
                ws.onerror = fail; ws.onclose = fail;
            });
            if (this.generation !== generation) throw new Error('连接已取消');
            ws.onmessage = ev => {
                let msg; try { msg = JSON.parse(ev.data); } catch { return; }
                const p = this._pending.get(msg.id);
                if (p && p.ws === ws) {
                    this._pending.delete(msg.id); clearTimeout(p.timer);
                    if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
                }
                if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId === this.sessionId && this.ws === ws) this.close();
            };
            ws.onclose = () => this._drop(ws, new Error('游戏连接已断开'));
            ws.onerror = () => { this._drop(ws, new Error('游戏调试连接出错')); try { ws.close(); } catch {} };
            const { targetInfos } = await this._send('Target.getTargets', {}, false);
            const pages = targetInfos.filter(t => t.type === 'page' && /\/index\.html?(?:[?#]|$)/i.test(t.url || ''));
            if (pages.length !== 1) throw new Error('无法唯一识别游戏主页面，请关闭多余游戏窗口');
            const { sessionId } = await this._send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true }, false);
            if (this.ws !== ws || this.generation !== generation) throw new Error('连接已更换');
            this.sessionId = sessionId;
        } catch (e) {
            if (ws) { this._drop(ws, e); try { ws.close(); } catch {} }
            throw e;
        }
    }
    _drop(ws, error) {
        for (const [id, p] of this._pending) if (p.ws === ws) {
            clearTimeout(p.timer); p.reject(error); this._pending.delete(id);
        }
        if (this.ws === ws) { this.ws = null; this.sessionId = null; }
    }
    _send(method, params = {}, session = true) {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1) return Promise.reject(new Error('游戏连接已断开'));
        const id = ++this._id, payload = { id, method, params };
        if (session && this.sessionId) payload.sessionId = this.sessionId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`CDP 调用超时: ${method}；不要立即重复操作，请先检查游戏状态`)); }, 20000);
            this._pending.set(id, { resolve, reject, timer, ws });
            try { ws.send(JSON.stringify(payload)); }
            catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
        });
    }
    async eval(expression) {
        await this.connect();
        const res = await this._send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
        return res.result?.value;
    }
    async evalJson(expression) {
        const value = await this.eval(expression);
        return typeof value === 'string' ? JSON.parse(value) : value;
    }
    async screenshot() { await this.connect(); return (await this._send('Page.captureScreenshot', { format: 'png' })).data; }
    close() {
        ++this.generation; this._connecting = null;
        const ws = this.ws;
        if (ws) { this._drop(ws, new Error('游戏连接已关闭或切换')); try { ws.close(); } catch {} }
    }
}
module.exports = { CdpClient, RECONNECT_DELAY_MS };
