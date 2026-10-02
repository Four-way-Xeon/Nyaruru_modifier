// 发布版专用。全文索引只存在于内存，不读写台词文件。
class StoryCache {
    constructor(cdp, ops, triggers, { retryMs = 3000, maxAttempts = 4, now = Date.now } = {}) {
        Object.assign(this, { cdp, ops, triggers, retryMs, maxAttempts, now });
        this.revision = 0;
        this.reset();
    }
    key() {
        return this.cdp.ws?.readyState === 1 && this.cdp.sessionId
            ? `${this.cdp.port}:${this.cdp.generation}:${this.cdp.sessionId}` : null;
    }
    reset(key = null) {
        this.connection = key;
        this.index = null;
        this.pending = null;
        this.attempts = 0;
        this.nextTryAt = 0;
        this.error = '';
        this.at = 0;
        ++this.revision;
    }
    sync() {
        const key = this.key();
        if (key !== this.connection) this.reset(key);
        return key;
    }
    status() {
        const key = this.sync();
        const loaded = !!this.index;
        return {
            state: !key ? 'disconnected' : loaded ? 'ready' : this.pending ? 'loading'
                : this.error ? (this.attempts >= this.maxAttempts ? 'error' : 'retrying') : 'waiting',
            loaded, revision: this.revision, connection: key, error: this.error,
            attempts: this.attempts, at: this.at,
            count: loaded ? Object.keys(this.index).length : 0,
            triggersWithLine: loaded ? this.triggers.filter(t => this.index[String(t.storyId)]).length : 0,
        };
    }
    get(id) { this.sync(); return this.index?.[String(id)] || null; }
    async ensure({ force = false } = {}) {
        let key = this.sync();
        if (!key) {
            if (!(await this.cdp.isAlive())) return null;
            try { await this.cdp.connect(); } catch { this.sync(); return null; }
            key = this.sync();
        }
        if (!key) return null;
        if (this.pending) return this.pending;
        if (force) { this.reset(key); }
        else if (this.index || this.attempts >= this.maxAttempts || this.now() < this.nextTryAt) return this.index;
        const revision = this.revision;
        ++this.attempts;
        const task = (async () => {
            try {
                const result = await this.cdp.evalJson(this.ops.readStoryIndex());
                if (this.key() !== key || this.revision !== revision) return null;
                if (!result?.ok || !result.index || !Object.keys(result.index).length) {
                    throw new Error(result?.error || '故事表尚未就绪或没有可读台词');
                }
                this.index = result.index;
                this.error = '';
                this.at = this.now();
                ++this.revision;
                return this.index;
            } catch (e) {
                if (this.key() !== key || this.revision !== revision) return null;
                this.error = String(e.message || e);
                this.nextTryAt = this.now() + this.retryMs;
                ++this.revision;
                return null;
            }
        })();
        this.pending = task;
        try { return await task; }
        finally { if (this.pending === task) this.pending = null; }
    }
}
module.exports = { StoryCache };
