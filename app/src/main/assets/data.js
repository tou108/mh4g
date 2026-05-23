// data.js - CSVデータ読み込みとパース

window.DB = {
    skills: [],       // {name, kei, pt, type}
    deco: [],         // {name, rare, slot, hr, mura, kei1, val1, kei2, val2}
    equip: {          // head/body/arm/wst/leg
        head: [], body: [], arm: [], wst: [], leg: []
    },
    charms: [],       // {name, slot, kei1, val1, kei2, val2}
    category: {},     // カテゴリ別スキル
    fukugo: [],       // 複合スキル
    kei: [],          // スキル系統一覧
    hakkutu: [],      // 発掘装備
};

function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    const result = [];
    for (const line of lines) {
        if (!line.trim() || line.startsWith('#')) continue;
        result.push(parseLine(line));
    }
    return result;
}

function parseLine(line) {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; }
        else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
        else { cur += c; }
    }
    cols.push(cur);
    return cols.map(s => s.trim());
}

async function loadAllData() {
    const files = [
        'data/MH4G_SKILL.csv',
        'data/MH4G_DECO.csv',
        'data/MH4G_EQUIP_HEAD.csv',
        'data/MH4G_EQUIP_BODY.csv',
        'data/MH4G_EQUIP_ARM.csv',
        'data/MH4G_EQUIP_WST.csv',
        'data/MH4G_EQUIP_LEG.csv',
        'data/MH4G_CHARM.csv',
        'data/conf/CATEGORY.txt',
        'data/conf/FUKUGO.txt',
        'data/conf/KEI.txt',
        'data/conf/HAKKUTU.csv',
    ];

    const texts = {};
    for (const f of files) {
        try {
            const content = Android.loadAsset(f);
            texts[f] = content || '';
        } catch(e) {
            texts[f] = '';
        }
    }

    // スキル
    for (const row of parseCSV(texts['data/MH4G_SKILL.csv'])) {
        if (row.length < 3) continue;
        DB.skills.push({ name: row[0], kei: row[1], pt: parseInt(row[2]) || 0, type: parseInt(row[3]) || 0 });
    }

    // 装飾品
    for (const row of parseCSV(texts['data/MH4G_DECO.csv'])) {
        if (row.length < 7) continue;
        DB.deco.push({
            name: row[0], rare: parseInt(row[1])||0, slot: parseInt(row[2])||0,
            hr: parseInt(row[3])||0, mura: parseInt(row[4])||0,
            kei1: row[5], val1: parseInt(row[6])||0,
            kei2: row[7]||'', val2: parseInt(row[8])||0,
        });
    }

    // 防具
    const equipKeys = ['head','body','arm','wst','leg'];
    const equipFiles = ['MH4G_EQUIP_HEAD','MH4G_EQUIP_BODY','MH4G_EQUIP_ARM','MH4G_EQUIP_WST','MH4G_EQUIP_LEG'];
    for (let i = 0; i < equipKeys.length; i++) {
        const key = equipKeys[i];
        const txt = texts[`data/${equipFiles[i]}.csv`];
        for (const row of parseCSV(txt)) {
            if (row.length < 14) continue;
            const e = {
                part: key,
                name: row[0], sex: parseInt(row[1])||0, type: parseInt(row[2])||0,
                rare: parseInt(row[3])||0, slot: parseInt(row[4])||0,
                hr: parseInt(row[5])||99, mura: parseInt(row[6])||99,
                defInit: parseInt(row[7])||0, defMax: parseInt(row[8])||0,
                fire: parseInt(row[9])||0, water: parseInt(row[10])||0,
                thunder: parseInt(row[11])||0, ice: parseInt(row[12])||0,
                dragon: parseInt(row[13])||0,
                skills: [],
            };
            // スキル系統最大5つ
            for (let j = 0; j < 5; j++) {
                const ki = row[14 + j*2];
                const vi = parseInt(row[15 + j*2]);
                if (ki && ki !== '' && !isNaN(vi) && vi !== 0) {
                    e.skills.push({ kei: ki, val: vi });
                }
            }
            DB.equip[key].push(e);
        }
    }

    // お守り
    for (const row of parseCSV(texts['data/MH4G_CHARM.csv'])) {
        if (row.length < 3) continue;
        DB.charms.push({
            name: row[0], slot: parseInt(row[1])||0,
            kei1: row[2]||'', val1: parseInt(row[3])||0,
            kei2: row[4]||'', val2: parseInt(row[5])||0,
        });
    }

    // カテゴリ
    for (const line of (texts['data/conf/CATEGORY.txt']||'').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const idx = line.indexOf(',');
        if (idx < 0) continue;
        const cat = line.substring(0, idx).trim();
        const skills = line.substring(idx+1).split(',').map(s=>s.trim()).filter(Boolean);
        DB.category[cat] = skills;
    }

    // 複合スキル
    for (const line of (texts['data/conf/FUKUGO.txt']||'').split(/\r?\n/)) {
        if (!line.trim() || line.startsWith('#')) continue;
        const cols = parseLine(line);
        if (cols.length >= 3) {
            DB.fukugo.push({ name: cols[0], reqs: cols.slice(1) });
        }
    }

    // KEI
    for (const line of (texts['data/conf/KEI.txt']||'').split(/\r?\n/)) {
        if (line.trim()) DB.kei.push(line.trim());
    }

    console.log(`Loaded: skills=${DB.skills.length}, deco=${DB.deco.length}, equip=${Object.values(DB.equip).reduce((a,b)=>a+b.length,0)}`);
}

// スキル系統 → 発動スキル のマップ
function buildSkillMap() {
    const map = {}; // kei -> [{name, pt, type}]
    for (const s of DB.skills) {
        if (!map[s.kei]) map[s.kei] = [];
        map[s.kei].push(s);
    }
    return map;
}

// ポイント合計からスキル発動判定
function calcSkills(keiTotals, type) {
    const skillMap = buildSkillMap();
    const activated = [];
    for (const [kei, total] of Object.entries(keiTotals)) {
        if (!skillMap[kei]) continue;
        // 最もptに近い（超えない）スキルを発動
        let best = null;
        for (const s of skillMap[kei]) {
            if (s.type !== 0 && s.type !== type) continue;
            if (s.pt > 0 && total >= s.pt) {
                if (!best || s.pt > best.pt) best = s;
            } else if (s.pt < 0 && total <= s.pt) {
                if (!best || s.pt < best.pt) best = s;
            }
        }
        if (best) activated.push(best);
    }
    return activated;
}
