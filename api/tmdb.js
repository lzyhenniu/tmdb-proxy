const TMDB_BASE_URL = 'https://api.themoviedb.org';

class RequestManager {
    constructor(options = {}) {
        this.cacheDuration = options.duration || 10 * 60 * 1000; // 10分钟
        this.maxSize = options.maxSize || 1000;
        
        // 1. 数据缓存 (存储结果)
        this.dataCache = new Map();
        
        // 2. 任务缓存 (存储正在进行中的 Promise)
        // Key: 请求URL, Value: Promise<ResponseData>
        this.pendingRequests = new Map();
    }

    /**
     * 核心方法：获取数据
     * 自动处理 缓存查找 -> 请求合并 -> 网络请求 -> 结果缓存
     */
    async fetch(key, fetcherFn) {
        // A. 检查数据缓存 (LRU 读取)
        const cached = this._getFromDataCache(key);
        if (cached) {
            console.log('✅ [Cache Hit] Data:', key);
            return cached;
        }

        // B. 检查是否已有正在进行的请求 (请求合并关键点)
        if (this.pendingRequests.has(key)) {
            console.log('⚡ [Coalescing] Waiting for pending request:', key);
            // 直接返回正在进行的 Promise，而不是发起新请求
            return this.pendingRequests.get(key);
        }

        // C. 发起新请求并缓存 Promise
        console.log('🚀 [Network] Fetching:', key);
        
        const promise = fetcherFn()
            .then((data) => {
                // 请求成功：写入数据缓存
                this._setToDataCache(key, data);
                return data;
            })
            .catch((err) => {
                // 请求失败：抛出异常，让调用者处理
                throw err;
            })
            .finally(() => {
                // D. 清理：无论成功失败，请求结束了，必须从 pending 中移除
                // 这样后续的新请求才会重新发起 fetch
                this.pendingRequests.delete(key);
            });

        // 将 Promise 存入 pending map
        this.pendingRequests.set(key, promise);

        return promise;
    }

    // --- 内部 LRU 辅助方法 ---

    _getFromDataCache(key) {
        const item = this.dataCache.get(key);
        if (!item) return null;

        if (Date.now() > item.expiry) {
            this.dataCache.delete(key);
            return null;
        }

        // LRU 刷新：重新插入以标记为最近使用
        this.dataCache.delete(key);
        this.dataCache.set(key, item);
        return item.data;
    }

    _setToDataCache(key, data) {
        // 如果满了，删除最早的一个 (Map 的第一个)
        if (this.dataCache.size >= this.maxSize) {
            const oldestKey = this.dataCache.keys().next().value;
            this.dataCache.delete(oldestKey);
        }
        
        this.dataCache.set(key, {
            data,
            expiry: Date.now() + this.cacheDuration
        });
    }
}

// 初始化单例
const manager = new RequestManager();

// --- Main Handler ---

module.exports = async (req, res) => {
    // CORS 设置
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const fullPath = req.url;
        const authHeader = req.headers.authorization;
        const cacheKey = fullPath; // 注意：如果是多用户私有数据，Key应包含 authHeader

        // 定义如何获取数据的函数 (Fetcher)
        // 这里的逻辑只会在 真正需要网络请求 时执行
        const performNetworkRequest = async () => {
            const tmdbUrl = `${TMDB_BASE_URL}${fullPath}`;
            const headers = { 
                'Accept': 'application/json',
                'Content-Type': 'application/json' 
            };
            if (authHeader) headers['Authorization'] = authHeader;

            const response = await fetch(tmdbUrl, { headers });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`TMDB API Error ${response.status}: ${errorText}`);
            }

            return await response.json();
        };

        // --- 核心调用 ---
        // 所有的魔法都在这里：如果是并发请求，performNetworkRequest 只会执行一次
        const data = await manager.fetch(cacheKey, performNetworkRequest);

        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(data));

    } catch (error) {
        console.error('Request Error:', error.message);
        // 区分错误类型简单处理
        const status = error.message.includes('TMDB API Error') ? 502 : 500;
        res.status(status).json({ error: error.message });
    }
};
