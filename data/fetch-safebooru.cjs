// 从 Safebooru API 预取图片数据，生成 JSON 文件供前端使用
// 用法: node fetch-safebooru.cjs
// 每标签抓取最多 10,000 张（100页×100），客户端用 tags 字段过滤低质量内容
// 自动去重 + 打乱 + 分片输出 JSON

const fs = require('fs');
const path = require('path');

const TAGS = {
    'thighhighs':        '白丝',
    'black_legwear':     '黑丝',
    'pantyhose':         '肉丝',
    'cat_ears':          '猫娘',
    'maid':              '女仆',
    'school_uniform':    'JK制服',
    'kimono':            '和服',
    'swimsuit':          '泳装',
    'serafuku':          '水手服',
    'twintails':         '双马尾',
    'glasses':           '眼镜娘',
};

const BASE = 'https://safebooru.org/index.php?page=dapi&s=post&q=index';
const PER_PAGE = 100;
const PAGES = 30;         // 约 2,500 张/标签（质量过滤后）
const MIN_RES = 500;      // 最小分辨率（宽高都 >= 500px）
const CHUNK_SIZE = 5000;  // all 分片大小
const TAG_CONCURRENCY = 3; // 并行抓取 3 个标签
const OUT_DIR = __dirname;

// 质量黑名单：API 返回的 tags 字段包含任意这些词就过滤掉
const BLACKLIST = [
    'chibi', 'monochrome', 'greyscale', 'sketch', 'lineart',
    '3d', 'realistic', 'photo', 'bad_id', 'lowres',
];

function isQualityImage(tags, w, h) {
    // 分辨率过滤
    if (!w || !h || w < MIN_RES || h < MIN_RES) return false;
    // 标签黑名单过滤
    if (!tags) return true;
    const lower = tags.toLowerCase();
    return !BLACKLIST.some(bl => lower.includes(bl));
}

async function fetchPage(tag, page) {
    const url = `${BASE}&tags=${encodeURIComponent(tag)}&limit=${PER_PAGE}&pid=${page}&json=1`;
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'MoePlanet/3.0' },
            signal: AbortSignal.timeout(25000),
        });
        if (!resp.ok) {
            console.log(`      HTTP ${resp.status}`);
            return { items: [], hasMore: false };
        }
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) return { items: [], hasMore: false };
        const hasMore = data.length >= PER_PAGE;
        const items = data
            .filter(x => isQualityImage(x.tags, x.width, x.height))
            .map(x => ({
                id: x.id,
                u: x.file_url,
                t: x.sample_url || x.preview_url || x.file_url,
                a: '',
                s: x.source || '',
                w: x.width,
                h: x.height,
            }));
        return { items, hasMore };
    } catch (err) {
        console.log(`      ${err.message}`);
        return { items: [], hasMore: false };
    }
}

async function fetchTag(tag, label) {
    const all = [];
    const seen = new Set();

    for (let p = 0; p < PAGES; p++) {
        const { items, hasMore } = await fetchPage(tag, p);
        let added = 0;
        for (const it of items) {
            if (!seen.has(it.id)) {
                seen.add(it.id);
                all.push(it);
                added++;
            }
        }
        if (p < 10 || p % 10 === 0) {
            console.log(`    [${label}] page ${p}: got ${items.length}, new ${added}, total ${all.length}`);
        }
        if (!hasMore) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`    ✅ [${label}] total ${all.length}`);
    return all;
}

async function main() {
    console.log('🔄 Fetching Safebooru (quality-filtered: -chibi -sketch -mono -3d, >=500px)...\n');

    const tagEntries = Object.entries(TAGS);
    const results = {};
    let total = 0;

    for (let i = 0; i < tagEntries.length; i += TAG_CONCURRENCY) {
        const batch = tagEntries.slice(i, i + TAG_CONCURRENCY);
        const promises = batch.map(([tag, label]) =>
            fetchTag(tag, label).then(items => ({ tag, items }))
        );
        const batchResults = await Promise.all(promises);
        for (const { tag, items } of batchResults) {
            results[tag] = items;
            total += items.length;
        }
        if (i + TAG_CONCURRENCY < tagEntries.length) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    console.log('\n📄 Writing tag files...');
    for (const [tag, items] of Object.entries(results)) {
        const fp = path.join(OUT_DIR, `${tag}.json`);
        fs.writeFileSync(fp, JSON.stringify(items), 'utf-8');
        console.log(`  ${tag}.json (${items.length}, ${(fs.statSync(fp).size/1024).toFixed(0)}KB)`);
    }

    // 全部合并文件（去重 + 打乱 + 分片）
    console.log('\n🔀 Building all chunks...');
    const allMap = new Map();
    for (const [tag, items] of Object.entries(results)) {
        for (const it of items) {
            if (!allMap.has(it.id)) allMap.set(it.id, it);
        }
    }
    const allArr = Array.from(allMap.values());
    console.log(`  Unique: ${allArr.length} / Total: ${total}`);

    // Fisher-Yates shuffle
    for (let i = allArr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allArr[i], allArr[j]] = [allArr[j], allArr[i]];
    }

    const chunks = Math.ceil(allArr.length / CHUNK_SIZE);
    for (let c = 0; c < chunks; c++) {
        const chunk = allArr.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        const fp = path.join(OUT_DIR, `all_${c}.json`);
        fs.writeFileSync(fp, JSON.stringify(chunk), 'utf-8');
        console.log(`  all_${c}.json (${chunk.length}, ${(fs.statSync(fp).size/1024).toFixed(0)}KB)`);
    }

    const index = {};
    for (const [tag, items] of Object.entries(results)) {
        index[tag] = items.length;
    }
    index.all = allArr.length;
    index.chunks = chunks;
    fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index), 'utf-8');

    console.log(`\n✨ Done! ${total} total, ${allArr.length} unique in ${chunks} chunks.`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
