// data.js - CSVデータ読み込みとパース

window.DB = {
    skills: [],
    deco: [],
    equip: { head: [], body: [], arm: [], wst: [], leg: [] },
    charms: [],
    category: {},
    fukugo: [],
    kei: [],
    hakkutu: [],  // 発掘装備データ { part, type, defMax, kei, val, hr, mura }
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
        'data/conf/SIBORI.txt',
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

    // お守り（護石テーブル）
    for (const row of parseCSV(texts['data/MH4G_CHARM.csv'])) {
        if (row.length < 2) continue;
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

    // ── 発掘装備データの解析 ──
    // フォーマット: 部位(0:武器/1:頭/2:胴/3:腕/4:腰/5:足), タイプ(0:両方/1:剣士/2:ガンナー),
    //              最低防御力, 最大防御力, スキル系統, スキル値, 入手時期(集☆), 入手時期(村☆)
    const partKeyMap = { 1:'head', 2:'body', 3:'arm', 4:'wst', 5:'leg' };
    for (const row of parseCSV(texts['data/conf/HAKKUTU.csv'])) {
        if (row.length < 6) continue;
        const partNum = parseInt(row[0]);
        if (!partKeyMap[partNum]) continue; // 武器(0)は除外
        const partKey = partKeyMap[partNum];
        const kei = row[4];
        const val = parseInt(row[5]) || 0;
        if (!kei || val === 0) continue;
        DB.hakkutu.push({
            part: partKey,
            type: parseInt(row[1]) || 0,
            defMin: parseInt(row[2]) || 0,
            defMax: parseInt(row[3]) || 0,
            kei: kei,
            val: val,
            hr:   parseInt(row[6]) || 8,
            mura: parseInt(row[7]) || 99,
        });
    }

    console.log(`Loaded: skills=${DB.skills.length}, deco=${DB.deco.length}, equip=${Object.values(DB.equip).reduce((a,b)=>a+b.length,0)}, hakkutu=${DB.hakkutu.length}`);
}

function buildSkillMap() {
    const map = {};
    for (const s of DB.skills) {
        if (!map[s.kei]) map[s.kei] = [];
        map[s.kei].push(s);
    }
    return map;
}

function calcSkills(keiTotals, type) {
    const skillMap = buildSkillMap();
    const activated = [];
    for (const [kei, total] of Object.entries(keiTotals)) {
        if (!skillMap[kei]) continue;
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
