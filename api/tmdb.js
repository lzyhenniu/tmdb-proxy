const { pipeline } = require('stream/promises'); // Node.js 流处理工具

// 配置
const API_BASE_URL = 'https://api.themoviedb.org';
const IMG_BASE_URL = 'https://image.tmdb.org';

// 缓存配置 (仅针对 API JSON 数据)
const CACHE_DURATION = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;

// --- 1. 请求管理器 (复用之前的逻辑，处理 API 缓存) ---
class RequestManager {
    constructor() {
        this.dataCache = new Map();
        this.pendingRequests = new Map();
    }

    async fetch(key, fetcherFn) {
        // A. 读缓存
        const cached = this._getFromDataCache(key);
        if (cached) return cached;

        // B. 请求合并
        if (this.pendingRequests.has(key)) return this.pendingRequests.get(key);

        // C. 发起网络请求
        const promise = fetcherFn()
            .then(data => {
                this._setToDataCache(key, data);
                return data;
            })
            .finally(() => this.pendingRequests.delete(key));

        this.pendingRequests.set(key, promise);
        return promise;
    }

    _getFromDataCache(key) {
        const item = this.dataCache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.dataCache.delete(key);
            return null;
        }
        // LRU 刷新
        this.dataCache.delete(key);
        this.dataCache.set(key, item);
        return item.data;
    }

    _setToDataCache(key, data) {
        if (this.dataCache.size >= MAX_CACHE_SIZE) {
            this.dataCache.delete(this.dataCache.keys().next().value);
        }
        this.dataCache.set(key, { data, expiry: Date.now() + CACHE_DURATION });
    }
}

const manager = new RequestManager();

// --- 2. 主处理函数 ---

module.exports = async (req, res) => {
    // CORS 设置
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const fullPath = req.url;
        
        // --- 路由判断核心逻辑 ---
        
        // 情况 A: 图片请求 (路径通常包含 /t/p/w500/...)
        // 图片不需要 JS 内存缓存 (体积大，且浏览器自带缓存)，直接流式透传
        if (fullPath.startsWith('/t/p/') || fullPath.startsWith('/t/original/')) {
            console.log('🖼️ [Image Proxy]:', fullPath);
            
            const imgUrl = `${IMG_BASE_URL}${fullPath}`;
            const imgResponse = await fetch(imgUrl);

            if (!imgResponse.ok) {
                return res.status(imgResponse.status).end();
            }

            // 转发 Content-Type (如 image/jpeg) 和 Cache-Control
            res.setHeader('Content-Type', imgResponse.headers.get('content-type'));
            res.setHeader('Cache-Control', 'public, max-age=31536000'); // 让浏览器缓存图片一年

            // 将 Web Stream 转换为 Node Stream 并管道传输给响应
            // 注意：Node 18+ 的 fetch body 是 Web ReadableStream
            const reader = imgResponse.body.getReader();
            const stream = new ReadableStream({
                start(controller) {
                    return pump();
                    function pump() {
                        return reader.read().then(({ done, value }) => {
                            if (done) { controller.close(); return; }
                            controller.enqueue(value);
                            return pump();
                        });
                    }
                }
            });
            
            // 下面是一种将 Web Stream 转为 Node Stream 的简便方法，或者直接把 Buffer 写回
            const buffer = await imgResponse.arrayBuffer();
            return res.status(200).send(Buffer.from(buffer));
        }

        // 情况 B: API 请求 (走缓存 + 请求合并)
        console.log('📝 [API Proxy]:', fullPath);
        
        const apiData = await manager.fetch(fullPath, async () => {
            const apiUrl = `${API_BASE_URL}${fullPath}`;
            const headers = { 
                'Accept': 'application/json',
                'Content-Type': 'application/json' 
            };
            if (req.headers.authorization) {
                headers['Authorization'] = req.headers.authorization;
            }

            const response = await fetch(apiUrl, { headers });
            
            if (!response.ok) {
                const txt = await response.text();
                throw new Error(txt || response.statusText);
            }
            
            return await response.json();
        });

        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(apiData));

    } catch (error) {
        console.error('Proxy Error:', error);
        res.status(500).json({ error: 'Proxy Error', details: error.message });
    }
};
