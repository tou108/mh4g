// app.js - アプリロジック (モバイル対応版)

let selectedSkills = [];
let charmList = [];
let mysets = [];
let fixedEquip = { head:null, body:null, arm:null, wst:null, leg:null, charm:null };
let excludeEquip = { head:[], body:[], arm:[], wst:[], leg:[], charm:[], deco:[] };
let currentResult = null;
let editingCharmIdx = -1;
let settingsOpen = true;

window.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadAllData();
        initUI();
        loadSaved();
        document.getElementById('loading').style.display = 'none';
    } catch(e) {
        document.getElementById('loading').innerHTML = `<div class="title">エラー</div><div class="sub">${e.message}</div>`;
    }
});

function initUI() {
    const catSel = document.getElementById('cat-select');
    addOption(catSel, '__recent', '最近');
    addOption(catSel, '__all', '全て');
    for (const cat of Object.keys(DB.category)) addOption(catSel, cat, cat);
    onCatChange();

    const keis = [...new Set(DB.skills.map(s => s.kei))].sort();
    for (const id of ['cd-kei1','cd-kei2']) {
        const sel = document.getElementById(id);
        sel.innerHTML = '<option value="">（なし）</option>';
        for (const k of keis) addOption(sel, k, k);
    }
}

function addOption(sel, val, text) {
    const o = document.createElement('option');
    o.value = val; o.textContent = text; sel.appendChild(o);
}

// ===== タブ =====
function showTab(name) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const el = document.getElementById('tab-' + name);
    if (el) el.classList.add('active');
    const names = ['simu','charm','myset','kotei','jyogai','decoex','hakkutu'];
    const idx = names.indexOf(name);
    const btns = document.querySelectorAll('.tab-btn');
    if (idx >= 0 && btns[idx]) btns[idx].classList.add('active');
    if (name === 'charm') renderCharmTable();
    if (name === 'myset') renderMysetTable();
    if (name === 'kotei') renderFixedTable();
    if (name === 'jyogai') renderExcludeTable();
    if (name === 'decoex') renderDecoExcludeTable();
}

// ===== 設定パネル折りたたみ =====
function toggleSettings() {
    settingsOpen = !settingsOpen;
    const panel = document.getElementById('settings-panel');
    const arrow = document.getElementById('toggle-arrow');
    const label = document.getElementById('settings-label');
    if (settingsOpen) {
        panel.classList.remove('collapsed');
        arrow.classList.add('open');
        label.textContent = '⚙ 設定（タップで閉じる）';
    } else {
        panel.classList.add('collapsed');
        arrow.classList.remove('open');
        label.textContent = '⚙ 設定（タップで開く）';
    }
}

// ===== スキル選択 =====
function onCatChange() {
    const cat = document.getElementById('cat-select').value;
    const sel = document.getElementById('skill-select');
    sel.innerHTML = '';
    let skills = [];
    if (cat === '__all') skills = DB.skills.map(s => s.name);
    else if (cat === '__recent') skills = getRecentSkills();
    else skills = DB.category[cat] || [];
    for (const s of skills) addOption(sel, s, s);
}

function getRecentSkills() {
    try { const s = Android.loadData('recent_skills'); return s ? JSON.parse(s) : []; } catch(e) { return []; }
}
function addRecentSkill(name) {
    let r = getRecentSkills();
    r = [name, ...r.filter(s => s !== name)].slice(0, 20);
    Android.saveData('recent_skills', JSON.stringify(r));
}

function addSelectedSkill() {
    const skillName = document.getElementById('skill-select').value;
    if (!skillName) return;
    if (selectedSkills.some(s => s.name === skillName)) return;
    if (selectedSkills.length >= 10) { alert('スキルは10個まで'); return; }
    const info = DB.skills.find(s => s.name === skillName);
    if (!info) return;
    selectedSkills.push({ kei: info.kei, name: skillName, pt: info.pt });
    addRecentSkill(skillName);
    renderSelectedSkills();
}
function removeSkill(i) { selectedSkills.splice(i, 1); renderSelectedSkills(); }
function clearAllSkills() { selectedSkills = []; renderSelectedSkills(); }

function renderSelectedSkills() {
    const el = document.getElementById('selected-skills');
    el.innerHTML = '';
    selectedSkills.forEach((s, i) => {
        const chip = document.createElement('div');
        chip.className = 'skill-chip';
        chip.innerHTML = `<span>${s.pt < 0 ? '−' : ''}${s.name}</span><button class="del-x" onclick="removeSkill(${i})">×</button>`;
        el.appendChild(chip);
    });
}

// ===== 検索 =====
async function doSearch() {
    if (selectedSkills.length === 0) { alert('スキルを選択してください'); return; }

    const weaponSlotVal = parseInt(document.getElementById('weapon-slot').value);
    const cond = {
        targetSkills: selectedSkills.map(s => ({ kei: s.kei, pt: s.pt })),
        excludeSkills: selectedSkills.filter(s => s.pt < 0).map(s => ({ kei: s.kei, pt: s.pt })),
        weaponSlot: weaponSlotVal === -2 ? 0 : weaponSlotVal,
        useDecoration: weaponSlotVal !== -2,
        hunterType: parseInt(document.getElementById('hunter-type').value),
        gender: parseInt(document.getElementById('hunter-gender').value),
        maxResults: parseInt(document.getElementById('opt-effort').value) || 20,
        useExclude: document.getElementById('opt-exclude').checked,
        charmList: document.getElementById('opt-omamori').checked ? charmList : [],
        excludeEquip: document.getElementById('opt-exclude').checked ? excludeEquip : { head:[],body:[],arm:[],wst:[],leg:[],charm:[],deco:[] },
        fixedEquip: document.getElementById('opt-exclude').checked ? fixedEquip : { head:null,body:null,arm:null,wst:null,leg:null,charm:null },
    };

    // 設定パネルを閉じて結果を広く表示
    if (settingsOpen) toggleSettings();

    document.getElementById('search-btn').style.display = 'none';
    document.getElementById('abort-btn').classList.add('show');
    document.getElementById('result-label').textContent = '検索中...';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('result-tbody').innerHTML = '';

    const t0 = Date.now();
    window.onSearchProgress = (count, found) => {
        document.getElementById('result-label').textContent = `検索中... ${found}件`;
    };
    window.onSearchComplete = (results) => {
        const ms = Date.now() - t0;
        document.getElementById('result-label').textContent =
            `${SearchState.aborted && results.length < cond.maxResults ? '中断 ' : ''}${results.length}件 (${ms}ms)`;
        document.getElementById('search-btn').style.display = '';
        document.getElementById('abort-btn').classList.remove('show');
        document.getElementById('progress-bar').style.width = '100%';
        renderResults(results);
    };
    await startSearch(cond);
}

function doAbort() { abortSearch(); }

function renderResults(results) {
    const tbody = document.getElementById('result-tbody');
    tbody.innerHTML = '';
    results.forEach((r, i) => {
        const [head, body, arm, wst, leg] = r.equips;
        const totalDef = r.equips.reduce((s, e) => s + (e && e.name !== '装備なし' ? (e.defMax||0) : 0), 0);
        const tr = document.createElement('tr');
        const charmStr = r.charm ? (r.charm.kei1 ? r.charm.kei1.substring(0,4) : '護石') : '－';
        tr.innerHTML = `
          <td style="color:#888;text-align:center;">${i+1}</td>
          <td>${shortName(head)}</td>
          <td>${shortName(body)}</td>
          <td>${shortName(arm)}</td>
          <td>${shortName(wst)}</td>
          <td>${shortName(leg)}</td>
          <td>${charmStr}</td>
          <td style="text-align:right;">${totalDef}</td>`;
        tr.addEventListener('click', () => {
            document.querySelectorAll('#result-tbody tr').forEach(t => t.classList.remove('selected'));
            tr.classList.add('selected');
            showDetailModal(r);
        });
        tbody.appendChild(tr);
    });
}

function shortName(e) {
    if (!e || e.name === '装備なし') return '－';
    return e.name.replace(/【.*?】/g, '').replace(/（.*?）/g, '').substring(0, 8);
}

// ===== 詳細モーダル =====
function showDetailModal(r) {
    currentResult = r;
    const lines = [];
    const pJp = ['頭','胴','腕','腰','脚'];
    lines.push('【装備】');
    r.equips.forEach((e, i) => lines.push(`${pJp[i]}: ${e ? e.name : '装備なし'}`));
    if (r.charm) {
        const c = r.charm;
        lines.push(`護石: スロ${c.slot} ${c.kei1||''}${c.val1 >= 0 ? '+'+c.val1 : c.val1} ${c.kei2 ? c.kei2+(c.val2>=0?'+'+c.val2:c.val2) : ''}`);
    } else { lines.push('護石: なし'); }
    if (r.decos && r.decos.length > 0) {
        lines.push('');
        lines.push('【装飾品】');
        r.decos.forEach(d => { if (d && d.deco) lines.push(`${d.deco.name}${d.count > 1 ? '×'+d.count : ''}`); });
    }
    const totalFire = r.equips.reduce((s,e) => s+(e?e.fire||0:0), 0);
    const totalWater = r.equips.reduce((s,e) => s+(e?e.water||0:0), 0);
    const totalThunder = r.equips.reduce((s,e) => s+(e?e.thunder||0:0), 0);
    const totalIce = r.equips.reduce((s,e) => s+(e?e.ice||0:0), 0);
    const totalDragon = r.equips.reduce((s,e) => s+(e?e.dragon||0:0), 0);
    lines.push('');
    lines.push(`【耐性】火${totalFire} 水${totalWater} 雷${totalThunder} 氷${totalIce} 龍${totalDragon}`);
    lines.push('');
    lines.push('【発動スキル】');
    (r.skills && r.skills.length > 0) ? r.skills.forEach(s => lines.push(s.name)) : lines.push('（なし）');
    lines.push('');
    lines.push('【系統ポイント】');
    Object.entries(r.keiTotals||{}).filter(([,v])=>v!==0).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).forEach(([k,v])=>lines.push(`${k}: ${v}`));
    document.getElementById('detail-text').textContent = lines.join('\n');
    document.getElementById('detail-modal').classList.add('show');
}

function closeDetail(e) { if (e.target === document.getElementById('detail-modal')) closeDetailModal(); }
function closeDetailModal() { document.getElementById('detail-modal').classList.remove('show'); }

function detailAddMyset() {
    if (!currentResult) return;
    const name = prompt('セット名', '新しいセット');
    if (!name) return;
    mysets.push({ name, equips: currentResult.equips, charm: currentResult.charm, decos: currentResult.decos, skills: currentResult.skills, skillStr: (currentResult.skills||[]).map(s=>s.name).join(', '), memo:'' });
    saveMyset();
    alert('マイセットに追加しました');
}
function detailCopy() {
    if (!currentResult) return;
    const pJp = ['頭','胴','腕','腰','脚'];
    let s = currentResult.equips.map((e,i) => `${pJp[i]}：${e?e.name:'装備なし'}`).join('\n');
    if (currentResult.charm) s += `\n護石：${currentResult.charm.kei1||''}${currentResult.charm.val1||''}`;
    s += `\nスキル：${(currentResult.skills||[]).map(sk=>sk.name).join(', ')}`;
    Android.copyToClipboard(s);
    alert('コピーしました');
}
function detailFixHead() {
    if (!currentResult || !currentResult.equips[0] || currentResult.equips[0].name === '装備なし') { alert('頭装備がありません'); return; }
    fixedEquip.head = currentResult.equips[0];
    saveFixedExclude(); renderFixedTable();
    alert(`${fixedEquip.head.name} を固定しました`);
    closeDetailModal();
}
function detailExclHead() {
    if (!currentResult || !currentResult.equips[0] || currentResult.equips[0].name === '装備なし') { alert('頭装備がありません'); return; }
    const name = currentResult.equips[0].name;
    if (!excludeEquip.head.includes(name)) excludeEquip.head.push(name);
    saveFixedExclude(); renderExcludeTable();
    alert(`${name} を除外しました`);
    closeDetailModal();
}

// ===== お守り =====
function openCharmDialog(idx) {
    editingCharmIdx = idx !== null ? idx : -1;
    const c = idx !== null && idx >= 0 ? charmList[idx] : null;
    document.getElementById('cd-kei1').value = c ? (c.kei1||'') : '';
    document.getElementById('cd-val1').value = c ? (c.val1||0) : 0;
    document.getElementById('cd-kei2').value = c ? (c.kei2||'') : '';
    document.getElementById('cd-val2').value = c ? (c.val2||0) : 0;
    document.getElementById('cd-slot').value = c ? (c.slot||0) : 0;
    document.getElementById('charm-dialog').classList.add('show');
}
function closeCharmDialog() { document.getElementById('charm-dialog').classList.remove('show'); }
function saveCharm() {
    const kei1 = document.getElementById('cd-kei1').value;
    const val1 = parseInt(document.getElementById('cd-val1').value)||0;
    const kei2 = document.getElementById('cd-kei2').value;
    const val2 = parseInt(document.getElementById('cd-val2').value)||0;
    const slot = parseInt(document.getElementById('cd-slot').value)||0;
    if (!kei1 && !kei2) { alert('系統を選択してください'); return; }
    const charm = { name:`護石(スロ${slot} ${kei1}${val1}${kei2?' '+kei2+val2:''})`, slot, kei1, val1, kei2, val2 };
    if (editingCharmIdx >= 0) charmList[editingCharmIdx] = charm; else charmList.push(charm);
    saveCharmList(); renderCharmTable(); closeCharmDialog();
}
function deleteCharm(i) { if (confirm('削除しますか？')) { charmList.splice(i,1); saveCharmList(); renderCharmTable(); } }
function clearAllCharms() { if (confirm('全削除しますか？')) { charmList=[]; saveCharmList(); renderCharmTable(); } }
function sortCharms() {
    charmList.sort((a,b)=>(a.kei1||'').localeCompare(b.kei1||'')||b.val1-a.val1||b.slot-a.slot);
    saveCharmList(); renderCharmTable();
}
function renderCharmTable() {
    const tbody = document.getElementById('charm-tbody');
    tbody.innerHTML = '';
    charmList.forEach((c,i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${c.slot}</td><td>${c.kei1||''}</td><td>${c.val1||0}</td><td>${c.kei2||''}</td><td>${c.val2||0}</td>
          <td><button onclick="openCharmDialog(${i})">編集</button> <button onclick="deleteCharm(${i})">削除</button></td>`;
        tbody.appendChild(tr);
    });
}

// ===== マイセット =====
function renderMysetTable() {
    const tbody = document.getElementById('myset-tbody');
    tbody.innerHTML = '';
    mysets.forEach((m,i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${m.name||''}</td><td style="font-size:11px;">${m.skillStr||''}</td>
          <td><button onclick="deleteMySet(${i})">削除</button></td>`;
        tbody.appendChild(tr);
    });
}
function deleteMySet(i) { if(confirm('削除しますか？')){ mysets.splice(i,1); saveMyset(); renderMysetTable(); } }
function clearAllMysets() { if(confirm('全削除しますか？')){ mysets=[]; saveMyset(); renderMysetTable(); } }

// ===== 固定装備 =====
function renderFixedTable() {
    ['head','body','arm','wst','leg'].forEach(p => {
        const el = document.getElementById('fixed-'+p+'-name');
        if (el) el.textContent = fixedEquip[p] ? fixedEquip[p].name : '（なし）';
    });
}
function clearFixed(part) {
    if (part) fixedEquip[part] = null;
    else fixedEquip = { head:null,body:null,arm:null,wst:null,leg:null,charm:null };
    saveFixedExclude(); renderFixedTable();
}

// ===== 除外装備 =====
function renderExcludeTable() {
    const tbody = document.getElementById('jyogai-tbody');
    tbody.innerHTML = '';
    const parts = ['head','body','arm','wst','leg']; const pJp=['頭','胴','腕','腰','脚'];
    parts.forEach((p,pi) => (excludeEquip[p]||[]).forEach((name,i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${pJp[pi]}</td><td>${name}</td><td><button onclick="removeExclude('${p}',${i})">削除</button></td>`;
        tbody.appendChild(tr);
    }));
}
function removeExclude(p,i) { excludeEquip[p].splice(i,1); saveFixedExclude(); renderExcludeTable(); }
function clearAllExclude() { if(confirm('全クリアしますか？')){ excludeEquip={head:[],body:[],arm:[],wst:[],leg:[],charm:[],deco:[]}; saveFixedExclude(); renderExcludeTable(); } }

// ===== 装飾品除外 =====
function renderDecoExcludeTable() {
    const tbody = document.getElementById('decoex-tbody');
    tbody.innerHTML = '';
    (excludeEquip.deco||[]).forEach((name,i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${name}</td><td><button onclick="removeDecoExclude(${i})">削除</button></td>`;
        tbody.appendChild(tr);
    });
}
function removeDecoExclude(i) { excludeEquip.deco.splice(i,1); saveFixedExclude(); renderDecoExcludeTable(); }
function clearDecoExclude() { if(confirm('全クリアしますか？')){ excludeEquip.deco=[]; saveFixedExclude(); renderDecoExcludeTable(); } }

// ===== 保存/読み込み =====
function saveCharmList() { Android.saveData('charm_list', JSON.stringify(charmList)); }
function saveMyset() {
    Android.saveData('myset_list', JSON.stringify(mysets.map(m => ({
        ...m, equips: (m.equips||[]).map(e => e ? e.name : null), charmName: m.charm ? m.charm.name : null
    }))));
}
function saveFixedExclude() {
    Android.saveData('fixed_equip', JSON.stringify({
        fixed: Object.fromEntries(['head','body','arm','wst','leg'].map(p => [p, fixedEquip[p] ? fixedEquip[p].name : null])),
        exclude: excludeEquip
    }));
}
function saveOpts() {
    Android.saveData('search_opts', JSON.stringify({
        useExclude: document.getElementById('opt-exclude').checked,
        useOmamori: document.getElementById('opt-omamori').checked,
        matome: document.getElementById('opt-matome').checked,
        hakkutuAll: document.getElementById('opt-hakkutu').checked,
        effort: document.getElementById('opt-effort').value,
        weaponSlot: document.getElementById('weapon-slot').value,
        hunterType: document.getElementById('hunter-type').value,
        gender: document.getElementById('hunter-gender').value,
    }));
}
function loadSaved() {
    try { const cl = Android.loadData('charm_list'); if(cl) charmList = JSON.parse(cl); } catch(e){}
    try {
        const ms = Android.loadData('myset_list');
        if (ms) {
            mysets = JSON.parse(ms).map(m => ({
                ...m, equips: (m.equips||[]).map(n => {
                    if (!n) return null;
                    for (const p of ['head','body','arm','wst','leg']) { const e = DB.equip[p].find(eq=>eq.name===n); if(e) return e; }
                    return null;
                })
            }));
        }
    } catch(e){}
    try {
        const fe = Android.loadData('fixed_equip');
        if (fe) {
            const parsed = JSON.parse(fe);
            if (parsed.fixed) ['head','body','arm','wst','leg'].forEach(p => {
                const n = parsed.fixed[p];
                if (n) fixedEquip[p] = DB.equip[p].find(e=>e.name===n)||null;
            });
            if (parsed.exclude) excludeEquip = { ...excludeEquip, ...parsed.exclude };
        }
    } catch(e){}
    try {
        const opts = Android.loadData('search_opts');
        if (opts) {
            const o = JSON.parse(opts);
            if (o.useExclude !== undefined) document.getElementById('opt-exclude').checked = o.useExclude;
            if (o.useOmamori !== undefined) document.getElementById('opt-omamori').checked = o.useOmamori;
            if (o.matome !== undefined) document.getElementById('opt-matome').checked = o.matome;
            if (o.hakkutuAll !== undefined) document.getElementById('opt-hakkutu').checked = o.hakkutuAll;
            if (o.effort) document.getElementById('opt-effort').value = o.effort;
            if (o.weaponSlot) document.getElementById('weapon-slot').value = o.weaponSlot;
            if (o.hunterType) document.getElementById('hunter-type').value = o.hunterType;
            if (o.gender) document.getElementById('hunter-gender').value = o.gender;
        }
    } catch(e){}
}
