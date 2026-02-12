// 移除 axios 依赖，使用原生 fetch (Node.js 18+)
const TMDB_BASE_URL = 'https://api.themoviedb.org';

// 配置常量
const CACHE_DURATION = 10 * 60 * 1000; // 10分钟
const MAX_CACHE_SIZE = 1000;

// 使用 Map 作为 LRU 缓存 (Map 会按照插入顺序保存 Key)
const cache = new Map();

/**
 * 写入缓存并强制执行 LRU 策略 (删除最久未使用的)
 */
function setCache(key, data) {
    // 如果键已存在，先删除以更新其在 Map 中的位置（移到最后）
    if (cache.has(key)) {
        cache.delete(key);
    }

    // 如果超出大小，删除最旧的元素 (Map.keys().next() 获取的是第一个插入的元素)
    if (cache.size >= MAX_CACHE_SIZE) {
        const oldestKey = cache.keys().下一处()。value;
        cache.delete(oldestKey);
    }

    cache.set(key, {
        data,
        expiry: Date.当前() + CACHE_DURATION
    });
}

/**
 * 获取缓存
 * 包含惰性过期检查
 */
function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;

    // 检查过期
    if (Date.当前() > item.expiry) {
        cache.delete(key);
        return null;
    }

    // LRU 核心机制：读取命中后，重新 set 一次，将其移到 Map 末尾（表示最近刚被使用）
    // 注意：如果你只想做 TTL (Time To Live) 而不关心 LRU，可以注释掉下面这行
    cache.delete(key);
    cache.set(key, item); 

    return item.data;
}

module.exports = async (req, res) => {
    // 1. 设置 CORS (保持原样)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const fullPath = req.url;
        const authHeader = req.headers.authorization;
        const cacheKey = fullPath; // 可以考虑加入 authHeader 作为 key 的一部分以区分用户

        // 2. 检查缓存
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            console.log('Cache hit:', fullPath);
            // 这里显式设置 Content-Type，防止客户端解析错误
            res.setHeader('Content-Type', 'application/json');
            return res.status(200).send(JSON.stringify(cachedData));
        }

        // 3. 构建请求
        const tmdbUrl = `${TMDB_BASE_URL}${fullPath}`;
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }

        // 4. 发送原生 fetch 请求
        const response = await fetch(tmdbUrl, {
            method: 'GET',
            headers: headers
        });

        // 5. 处理响应
        if (!response.ok) {
            // 透传错误状态码
            const errorData = await response.text(); // 使用 text 以防万一 TMDB 返回非 JSON
            console.warn(`TMDB API Error: ${response.status} ${response.statusText}`);
            return res.status(response.status).send(errorData);
        }

        const data = await response.json();

        // 6. 写入缓存 (仅在成功时)
        setCache(cacheKey, data);
        console.log('Cache miss - Stored:', fullPath);

        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(data));

    } catch (error) {
        console.error('Proxy Error:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: error.message
        });
    }
};
