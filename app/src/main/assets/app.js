// app.js - アプリケーションロジック・UI制御

// ===== 状態 =====
let selectedSkills = []; // [{kei, name, pt}] - スキル選択中のリスト
let charmList = [];      // [{name,slot,kei1,val1,kei2,val2}]
let mysets = [];         // [{name,memo,equips,charm,decos,skills}]
let fixedEquip = { head:null, body:null, arm:null, wst:null, leg:null, charm:null };
let excludeEquip = { head:[], body:[], arm:[], wst:[], leg:[], charm:[], deco:[] };
let ctxTarget = null;    // コンテキストメニュー対象の結果
let editingCharmIdx = -1;

// ===== 初期化 =====
window.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('loading').style.display = 'flex';
    try {
        await loadAllData();
        initUI();
        loadSaved();
        document.getElementById('loading').style.display = 'none';
    } catch(e) {
        console.error(e);
        document.getElementById('loading').innerHTML = `<div>エラー: ${e.message}</div>`;
    }
});

function initUI() {
    // カテゴリ選択プルダウン構築
    const catSel = document.getElementById('cat-select');
    catSel.innerHTML = '';
    const cats = Object.keys(DB.category);
    // 最近使ったスキル + カテゴリ別
    addOption(catSel, '__recent', '最近使ったスキル');
    addOption(catSel, '__all', '全て');
    for (const cat of cats) {
        addOption(catSel, cat, cat);
    }
    onCatChange();

    // お守りダイアログのスキル系統プルダウン構築
    const keis = [...new Set(DB.skills.map(s => s.kei))].sort();
    for (const id of ['cd-kei1', 'cd-kei2']) {
        const sel = document.getElementById(id);
        sel.innerHTML = '<option value="">（なし）</option>';
        for (const k of keis) addOption(sel, k, k);
    }

    // コンテキストメニュー外クリックで閉じる
    document.addEventListener('click', () => closeCtxMenu());
}

function addOption(sel, val, text) {
    const o = document.createElement('option');
    o.value = val; o.textContent = text;
    sel.appendChild(o);
}

// ===== タブ切り替え =====
function showTab(name) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const tabEl = document.getElementById('tab-' + name);
    if (tabEl) tabEl.classList.add('active');
    const btns = document.querySelectorAll('.tab-btn');
    const tabNames = ['simu','charm','myset','kotei','jyogai','decoex','hakkutu'];
    const idx = tabNames.indexOf(name);
    if (idx >= 0 && btns[idx]) btns[idx].classList.add('active');

    if (name === 'charm') renderCharmTable();
    if (name === 'myset') renderMysetTable();
    if (name === 'kotei') renderFixedTable();
    if (name === 'jyogai') renderExcludeTable();
    if (name === 'decoex') renderDecoExcludeTable();
}

// ===== スキル選択 =====
function onCatChange() {
    const cat = document.getElementById('cat-select').value;
    const sel = document.getElementById('skill-select');
    sel.innerHTML = '';
    let skills = [];
    if (cat === '__all') {
        skills = DB.skills.map(s => s.name);
    } else if (cat === '__recent') {
        skills = getRecentSkills();
    } else {
        skills = DB.category[cat] || [];
    }
    for (const s of skills) addOption(sel, s, s);
}

function getRecentSkills() {
    try {
        const saved = Android.loadData('recent_skills');
        return saved ? JSON.parse(saved) : [];
    } catch(e) { return []; }
}

function addRecentSkill(skillName) {
    let recent = getRecentSkills();
    recent = [skillName, ...recent.filter(s => s !== skillName)].slice(0, 20);
    Android.saveData('recent_skills', JSON.stringify(recent));
}

function addSelectedSkill() {
    const sel = document.getElementById('skill-select');
    const skillName = sel.value;
    if (!skillName) return;

    // 既に選択済みか
    if (selectedSkills.some(s => s.name === skillName)) return;
    if (selectedSkills.length >= 10) {
        alert('スキルは10個まで選択できます');
        return;
    }

    // スキル情報を取得
    const skillInfo = DB.skills.find(s => s.name === skillName);
    if (!skillInfo) return;

    selectedSkills.push({ kei: skillInfo.kei, name: skillName, pt: skillInfo.pt });
    addRecentSkill(skillName);
    renderSelectedSkills();
}

function removeSkill(idx) {
    selectedSkills.splice(idx, 1);
    renderSelectedSkills();
}

function clearAllSkills() {
    selectedSkills = [];
    renderSelectedSkills();
}

function renderSelectedSkills() {
    const el = document.getElementById('selected-skills');
    el.innerHTML = '';
    selectedSkills.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'skill-row';
        const negSign = s.pt < 0 ? '−' : '';
        row.innerHTML = `<span style="flex:1;font-size:12px;padding:1px 3px;">${negSign}${s.name}</span><button class="del-btn" onclick="removeSkill(${i})">×</button>`;
        el.appendChild(row);
    });
}

// ===== 検索 =====
async function doSearch() {
    if (selectedSkills.length === 0) {
        alert('スキルを選択してください');
        return;
    }

    const effort = parseInt(document.getElementById('opt-effort').value) || 20;
    const weaponSlotVal = parseInt(document.getElementById('weapon-slot').value);
    const hunterType = parseInt(document.getElementById('hunter-type').value);
    const gender = parseInt(document.getElementById('hunter-gender').value);
    const useExclude = document.getElementById('opt-exclude').checked;
    const useOmamori = document.getElementById('opt-omamori').checked;
    const hakkutuAll = document.getElementById('opt-hakkutu').checked;

    // お守りリストが空の場合は自動護石検索モードを有効化
    const effectiveCharmList = useOmamori ? charmList : [];
    const autoCharm = useOmamori && effectiveCharmList.length === 0;

    // 検索条件を構築
    const cond = {
        targetSkills: selectedSkills.map(s => ({ kei: s.kei, pt: s.pt })),
        excludeSkills: selectedSkills.filter(s => s.pt < 0).map(s => ({ kei: s.kei, pt: s.pt })),
        weaponSlot: weaponSlotVal === -2 ? 0 : weaponSlotVal,
        useDecoration: weaponSlotVal !== -2,
        hunterType, gender,
        maxResults: effort,
        useExclude,
        charmList: effectiveCharmList,
        autoCharm,
        hakkutuAll,
        excludeEquip: useExclude ? excludeEquip : { head:[],body:[],arm:[],wst:[],leg:[],charm:[],deco:[] },
        fixedEquip: useExclude ? fixedEquip : { head:null,body:null,arm:null,wst:null,leg:null,charm:null },
    };

    document.getElementById('search-btn').style.display = 'none';
    document.getElementById('abort-btn').style.display = '';
    document.getElementById('result-label').textContent = '検索中...';
    document.getElementById('progress-bar').style.width = '0%';

    const startTime = Date.now();

    window.onSearchProgress = (count, found) => {
        document.getElementById('result-label').textContent = `検索中... ${found}件`;
    };

    window.onSearchComplete = (results) => {
        const elapsed = Date.now() - startTime;
        document.getElementById('result-label').textContent = 
            SearchState.aborted ? `中断 ${results.length}件` : `検索完了 ${results.length}件`;
        document.getElementById('search-time').textContent = `${elapsed}ミリ秒`;
        document.getElementById('search-btn').style.display = '';
        document.getElementById('abort-btn').style.display = 'none';
        document.getElementById('progress-bar').style.width = '100%';
        renderResults(results);
    };

    await startSearch(cond);
}

function doAbort() {
    abortSearch();
}

function renderResults(results) {
    const tbody = document.getElementById('result-tbody');
    tbody.innerHTML = '';

    results.forEach((r, i) => {
        const tr = document.createElement('tr');
        const [head, body, arm, wst, leg] = r.equips;
        const charm = r.charm;
        const decos = r.decos || [];

        const decoStr = decos.map(d => {
            if (!d || !d.deco) return '';
            return d.count > 1 ? `${d.deco.name}×${d.count}` : d.deco.name;
        }).filter(Boolean).join(', ') || '　';

        const totalDef = r.equips.reduce((s, e) => s + (e && e.name !== '装備なし' ? (e.defMax||0) : 0), 0);
        const totalFire = r.equips.reduce((s, e) => s + (e ? (e.fire||0) : 0), 0);
        const totalWater = r.equips.reduce((s, e) => s + (e ? (e.water||0) : 0), 0);
        const totalThunder = r.equips.reduce((s, e) => s + (e ? (e.thunder||0) : 0), 0);
        const totalIce = r.equips.reduce((s, e) => s + (e ? (e.ice||0) : 0), 0);
        const totalDragon = r.equips.reduce((s, e) => s + (e ? (e.dragon||0) : 0), 0);
        const totalRes = totalFire + totalWater + totalThunder + totalIce + totalDragon;

        // 武器スロ
        const ws = parseInt(document.getElementById('weapon-slot').value);
        const wsStr = ws === -1 ? '自' : ws === -2 ? '-' : String(ws);

        tr.innerHTML = `
          <td>${head ? head.name : ''}</td>
          <td>${body ? body.name : ''}</td>
          <td>${arm ? arm.name : ''}</td>
          <td>${wst ? wst.name : ''}</td>
          <td>${leg ? leg.name : ''}</td>
          <td>${charm ? (charm.autoCharm || r.autoCharm ? `★${charm.kei1||''}${charm.val1||''}` : (charm.kei1 || '護石')) : '　'}</td>
          <td>${decoStr}</td>
          <td>${wsStr}</td>
          <td>${totalDef}</td>
          <td>${totalFire}</td>
          <td>${totalWater}</td>
          <td>${totalThunder}</td>
          <td>${totalIce}</td>
          <td>${totalDragon}</td>
          <td>${totalRes}</td>
        `;

        tr.addEventListener('click', () => selectResult(i, tr));
        tr.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            selectResult(i, tr);
            showCtxMenu(e.clientX, e.clientY, results[i]);
        });

        tbody.appendChild(tr);
    });
}

let selectedResultIdx = -1;

function selectResult(idx, tr) {
    document.querySelectorAll('#result-tbody tr').forEach(r => r.classList.remove('selected'));
    tr.classList.add('selected');
    selectedResultIdx = idx;
    showResultDetail(SearchResults[idx]);
}

function showResultDetail(r) {
    const lines = [];
    const parts = ['head','body','arm','wst','leg'];
    const partNames = ['頭','胴','腕','腰','脚'];
    const [head, body, arm, wst, leg] = r.equips;
    const equipArr = [head, body, arm, wst, leg];

    lines.push('【装備】');
    for (let i = 0; i < 5; i++) {
        const e = equipArr[i];
        lines.push(`${partNames[i]}: ${e ? e.name : '装備なし'}`);
    }
    if (r.charm) {
        const c = r.charm;
        const label = r.autoCharm ? '必要護石（自動）' : '護石';
        const slot = c.slot > 0 ? ` スロ${c.slot}` : '';
        const sk2 = c.kei2 ? ` / ${c.kei2}+${c.val2||''}` : '';
        lines.push(`${label}:${slot} ${c.kei1||''}+${c.val1||''}${sk2}`);
        if (r.autoCharm) {
            lines.push('  ※このスキルを持つ護石が必要です');
        }
    } else {
        lines.push('護石: なし');
    }

    // 装飾品
    if (r.decos && r.decos.length > 0) {
        lines.push('');
        lines.push('【装飾品】');
        for (const d of r.decos) {
            if (d && d.deco) {
                lines.push(`${d.deco.name}${d.count > 1 ? '×'+d.count : ''} (${d.deco.slot}スロ)`);
            }
        }
    }

    // 耐性
    lines.push('');
    lines.push('【耐性】');
    const totalFire = r.equips.reduce((s, e) => s + (e ? (e.fire||0) : 0), 0);
    const totalWater = r.equips.reduce((s, e) => s + (e ? (e.water||0) : 0), 0);
    const totalThunder = r.equips.reduce((s, e) => s + (e ? (e.thunder||0) : 0), 0);
    const totalIce = r.equips.reduce((s, e) => s + (e ? (e.ice||0) : 0), 0);
    const totalDragon = r.equips.reduce((s, e) => s + (e ? (e.dragon||0) : 0), 0);
    lines.push(`火${totalFire} 水${totalWater} 雷${totalThunder}`);
    lines.push(`氷${totalIce} 龍${totalDragon} 計${totalFire+totalWater+totalThunder+totalIce+totalDragon}`);

    // 発動スキル
    lines.push('');
    lines.push('【スキル】');
    if (r.skills && r.skills.length > 0) {
        for (const s of r.skills) {
            lines.push(s.name);
        }
    } else {
        lines.push('（なし）');
    }

    // スキル系統ポイント詳細
    lines.push('');
    lines.push('【スキル系統】');
    const sorted = Object.entries(r.keiTotals || {}).sort((a,b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [kei, val] of sorted) {
        if (val !== 0) lines.push(`${kei}: ${val}`);
    }

    document.getElementById('detail-text').textContent = lines.join('\n');
}

// ===== コンテキストメニュー =====
function showCtxMenu(x, y, result) {
    ctxTarget = result;
    const menu = document.getElementById('ctx-menu');
    menu.style.display = 'block';
    menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
    // 各部位固定/除外を表示
    const parts = ['head','body','arm','wst','leg'];
    const pJp = ['頭','胴','腕','腰','脚'];
    for (let i = 0; i < parts.length; i++) {
        const e = result.equips[i];
        const show = e && e.name !== '装備なし';
        document.getElementById('ctx-fix-' + parts[i]).style.display = show ? '' : 'none';
        document.getElementById('ctx-excl-' + parts[i]).style.display = show ? '' : 'none';
    }
}

function closeCtxMenu() {
    document.getElementById('ctx-menu').style.display = 'none';
}

function ctxAddMyset() {
    closeCtxMenu();
    if (!ctxTarget) return;
    const name = prompt('セット名を入力してください', '新しいセット');
    if (!name) return;
    const skillStr = (ctxTarget.skills||[]).map(s=>s.name).join(', ');
    mysets.push({
        name, memo: '',
        equips: ctxTarget.equips,
        charm: ctxTarget.charm,
        decos: ctxTarget.decos,
        skills: ctxTarget.skills,
        skillStr,
    });
    saveMyset();
    alert('マイセットに追加しました');
}

function ctxFix(part) {
    closeCtxMenu();
    if (!ctxTarget) return;
    const parts = ['head','body','arm','wst','leg'];
    const idx = parts.indexOf(part);
    if (idx < 0) return;
    fixedEquip[part] = ctxTarget.equips[idx];
    saveFixedExclude();
    renderFixedTable();
    alert(`${ctxTarget.equips[idx].name} を固定装備に設定しました`);
}

function ctxExcl(part) {
    closeCtxMenu();
    if (!ctxTarget) return;
    const parts = ['head','body','arm','wst','leg'];
    const idx = parts.indexOf(part);
    if (idx < 0) return;
    const ename = ctxTarget.equips[idx] && ctxTarget.equips[idx].name;
    if (!ename || ename === '装備なし') return;
    if (!excludeEquip[part].includes(ename)) excludeEquip[part].push(ename);
    saveFixedExclude();
    renderExcludeTable();
    alert(`${ename} を除外装備に追加しました`);
}

function ctxCopy() {
    closeCtxMenu();
    if (!ctxTarget) return;
    const text = formatResultFull(ctxTarget);
    Android.copyToClipboard(text);
    alert('クリップボードにコピーしました');
}

function ctxCopyShort() {
    closeCtxMenu();
    if (!ctxTarget) return;
    const text = formatResultShort(ctxTarget);
    Android.copyToClipboard(text);
    alert('クリップボードにコピーしました（省略版）');
}

function formatResultFull(r) {
    const parts = ['head','body','arm','wst','leg'];
    const pJp = ['頭','胴','腕','腰','脚'];
    let s = '';
    for (let i = 0; i < 5; i++) {
        const e = r.equips[i];
        s += `${pJp[i]}：${e ? e.name : '装備なし'}\n`;
    }
    if (r.charm) {
        const autoNote = r.autoCharm ? '【必要護石・自動】' : '護石';
        s += `${autoNote}：${r.charm.kei1||''}+${r.charm.val1||''} ${r.charm.kei2 ? r.charm.kei2+'+'+r.charm.val2 : ''} スロ${r.charm.slot||0}\n`;
    }
    if (r.decos && r.decos.length > 0) {
        s += `装飾品：${r.decos.map(d=>d&&d.deco?d.deco.name:'').filter(Boolean).join(', ')}\n`;
    }
    s += `スキル：${(r.skills||[]).map(sk=>sk.name).join(', ')}`;
    return s;
}

function formatResultShort(r) {
    return r.equips.map(e => e ? e.name.replace(/【.*】/, '').substring(0,8) : '-').join('/');
}

// ===== お守り設定 =====
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

function closeCharmDialog() {
    document.getElementById('charm-dialog').classList.remove('show');
}

function saveCharm() {
    const kei1 = document.getElementById('cd-kei1').value;
    const val1 = parseInt(document.getElementById('cd-val1').value) || 0;
    const kei2 = document.getElementById('cd-kei2').value;
    const val2 = parseInt(document.getElementById('cd-val2').value) || 0;
    const slot = parseInt(document.getElementById('cd-slot').value) || 0;

    if (!kei1 && !kei2) { alert('スキル系統を選択してください'); return; }

    const charm = {
        name: `護石(スロ${slot} ${kei1}${val1}${kei2?(' '+kei2+val2):''})`,
        slot, kei1, val1, kei2, val2
    };

    if (editingCharmIdx >= 0) {
        charmList[editingCharmIdx] = charm;
    } else {
        charmList.push(charm);
    }

    saveCharmList();
    renderCharmTable();
    closeCharmDialog();
}

function deleteCharm(idx) {
    if (confirm('このお守りを削除しますか？')) {
        charmList.splice(idx, 1);
        saveCharmList();
        renderCharmTable();
    }
}

function clearAllCharms() {
    if (confirm('全てのお守りを削除しますか？')) {
        charmList = [];
        saveCharmList();
        renderCharmTable();
    }
}

function sortCharms() {
    charmList.sort((a, b) => {
        if (a.kei1 !== b.kei1) return (a.kei1||'').localeCompare(b.kei1||'');
        if (b.val1 !== a.val1) return b.val1 - a.val1;
        return b.slot - a.slot;
    });
    saveCharmList();
    renderCharmTable();
}

function renderCharmTable() {
    const tbody = document.getElementById('charm-tbody');
    tbody.innerHTML = '';
    charmList.forEach((c, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${c.name||''}</td><td>${c.slot}</td><td>${c.kei1||''}</td><td>${c.val1||0}</td><td>${c.kei2||''}</td><td>${c.val2||0}</td>
          <td><button onclick="openCharmDialog(${i})" style="font-size:11px;padding:0 4px;border:1px solid #808080;background:#c0c0c0;cursor:pointer;">編集</button>
              <button onclick="deleteCharm(${i})" style="font-size:11px;padding:0 4px;border:1px solid #808080;background:#c0c0c0;cursor:pointer;">削除</button></td>`;
        tbody.appendChild(tr);
    });
}

// ===== マイセット =====
function renderMysetTable() {
    const tbody = document.getElementById('myset-tbody');
    tbody.innerHTML = '';
    mysets.forEach((m, i) => {
        const tr = document.createElement('tr');
        const equipStr = (m.equips || []).map(e => e ? e.name.substring(0,6) : '').join('/');
        tr.innerHTML = `<td>${m.name||''}</td><td>${m.skillStr||''}</td>
          <td colspan="5" style="font-size:11px;">${equipStr}</td>
          <td>${m.charm ? m.charm.kei1||'' : ''}</td>
          <td>${m.memo||''}</td>
          <td><button onclick="deleteMySet(${i})" style="font-size:11px;padding:0 4px;border:1px solid #808080;background:#c0c0c0;cursor:pointer;">削除</button></td>`;
        tbody.appendChild(tr);
    });
}

function deleteMySet(idx) {
    if (confirm('このセットを削除しますか？')) {
        mysets.splice(idx, 1);
        saveMyset();
        renderMysetTable();
    }
}

function clearAllMysets() {
    if (confirm('全てのマイセットを削除しますか？')) {
        mysets = [];
        saveMyset();
        renderMysetTable();
    }
}

// ===== 固定装備 =====
function renderFixedTable() {
    const parts = ['head','body','arm','wst','leg','charm'];
    const pJp = ['頭','胴','腕','腰','脚','お守り'];
    for (let i = 0; i < parts.length; i++) {
        const el = document.getElementById('fixed-' + parts[i] + '-name');
        if (el) {
            const fe = fixedEquip[parts[i]];
            el.textContent = fe ? fe.name : '（なし）';
        }
    }
}

function clearFixed(part) {
    if (part) {
        fixedEquip[part] = null;
    } else {
        fixedEquip = { head:null, body:null, arm:null, wst:null, leg:null, charm:null };
    }
    saveFixedExclude();
    renderFixedTable();
}

// ===== 除外装備 =====
function renderExcludeTable() {
    const tbody = document.getElementById('jyogai-tbody');
    tbody.innerHTML = '';
    const parts = ['head','body','arm','wst','leg','charm'];
    const pJp = ['頭','胴','腕','腰','脚','お守り'];
    for (let pi = 0; pi < parts.length; pi++) {
        const list = excludeEquip[parts[pi]] || [];
        for (let i = 0; i < list.length; i++) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${pJp[pi]}</td><td>${list[i]}</td>
              <td><button onclick="removeExclude('${parts[pi]}',${i})" style="font-size:11px;padding:0 4px;border:1px solid #808080;background:#c0c0c0;cursor:pointer;">削除</button></td>`;
            tbody.appendChild(tr);
        }
    }
}

function removeExclude(part, idx) {
    excludeEquip[part].splice(idx, 1);
    saveFixedExclude();
    renderExcludeTable();
}

function clearAllExclude() {
    if (confirm('全ての除外装備設定をクリアしますか？')) {
        excludeEquip = { head:[], body:[], arm:[], wst:[], leg:[], charm:[], deco:[] };
        saveFixedExclude();
        renderExcludeTable();
    }
}

// ===== 装飾品除外 =====
function renderDecoExcludeTable() {
    const tbody = document.getElementById('decoex-tbody');
    tbody.innerHTML = '';
    const list = excludeEquip.deco || [];
    for (let i = 0; i < list.length; i++) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${list[i]}</td>
          <td><button onclick="removeDecoExclude(${i})" style="font-size:11px;padding:0 4px;border:1px solid #808080;background:#c0c0c0;cursor:pointer;">削除</button></td>`;
        tbody.appendChild(tr);
    }
}

function removeDecoExclude(idx) {
    excludeEquip.deco.splice(idx, 1);
    saveFixedExclude();
    renderDecoExcludeTable();
}

function clearDecoExclude() {
    if (confirm('全ての装飾品除外設定をクリアしますか？')) {
        excludeEquip.deco = [];
        saveFixedExclude();
        renderDecoExcludeTable();
    }
}

// ===== 追加スキル検索 =====
function doExtraSkillSearch() {
    if (SearchResults.length === 0) { alert('先に検索を実行してください'); return; }
    extraSkillSearch(SearchResults, false);
}

function doExtraSkillSearchAll() {
    if (SearchResults.length === 0) { alert('先に検索を実行してください'); return; }
    extraSkillSearch(SearchResults, true);
}

function extraSkillSearch(results, allCharms) {
    // 結果から空きスロットを使って何か発動できるスキルを探す
    const activated = {};
    for (const r of results.slice(0, 50)) {
        const freeSlots = (r.equips || []).reduce((s, e) => s + (e ? e.slot : 0), 0);
        for (const d of DB.deco) {
            if (d.slot > freeSlots) continue;
            if (d.kei1) activated[d.kei1] = (activated[d.kei1] || 0) + 1;
        }
    }

    const tbody = document.getElementById('extra-skill-tbody');
    tbody.innerHTML = '';

    const sorted = Object.entries(activated).sort((a,b) => b[1]-a[1]).slice(0, 30);
    for (const [kei, cnt] of sorted) {
        // keiに対応するスキルを探す
        const skills = DB.skills.filter(s => s.kei === kei && s.pt > 0);
        for (const s of skills) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${s.name}</td><td>${cnt}件</td>`;
            tr.addEventListener('click', () => {
                if (selectedSkills.length < 10 && !selectedSkills.some(ss => ss.name === s.name)) {
                    selectedSkills.push({ kei: s.kei, name: s.name, pt: s.pt });
                    renderSelectedSkills();
                }
            });
            tbody.appendChild(tr);
        }
    }
}

// ===== 保存/読み込み =====
function saveCharmList() {
    Android.saveData('charm_list', JSON.stringify(charmList));
}

function saveMyset() {
    // equipsにはDBオブジェクトの参照が入っているので名前だけ保存
    const simplified = mysets.map(m => ({
        ...m,
        equips: (m.equips || []).map(e => e ? e.name : null),
        charmName: m.charm ? m.charm.name : null,
    }));
    Android.saveData('myset_list', JSON.stringify(simplified));
}

function saveFixedExclude() {
    Android.saveData('fixed_equip', JSON.stringify({
        fixed: {
            head: fixedEquip.head ? fixedEquip.head.name : null,
            body: fixedEquip.body ? fixedEquip.body.name : null,
            arm: fixedEquip.arm ? fixedEquip.arm.name : null,
            wst: fixedEquip.wst ? fixedEquip.wst.name : null,
            leg: fixedEquip.leg ? fixedEquip.leg.name : null,
        },
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
    // お守り
    try {
        const cl = Android.loadData('charm_list');
        if (cl) charmList = JSON.parse(cl);
    } catch(e) {}

    // マイセット
    try {
        const ms = Android.loadData('myset_list');
        if (ms) {
            const saved = JSON.parse(ms);
            mysets = saved.map(m => {
                const equips = (m.equips || []).map(n => {
                    if (!n) return null;
                    for (const part of ['head','body','arm','wst','leg']) {
                        const e = DB.equip[part].find(eq => eq.name === n);
                        if (e) return e;
                    }
                    return null;
                });
                return { ...m, equips };
            });
        }
    } catch(e) {}

    // 固定/除外
    try {
        const fe = Android.loadData('fixed_equip');
        if (fe) {
            const parsed = JSON.parse(fe);
            if (parsed.fixed) {
                for (const part of ['head','body','arm','wst','leg']) {
                    const n = parsed.fixed[part];
                    if (n) fixedEquip[part] = DB.equip[part].find(e => e.name === n) || null;
                }
            }
            if (parsed.exclude) excludeEquip = { ...excludeEquip, ...parsed.exclude };
        }
    } catch(e) {}

    // 検索オプション
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
    } catch(e) {}
}
