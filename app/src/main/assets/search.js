// search.js - スキルシミュレータ検索エンジン

// 検索状態
window.SearchState = {
    running: false,
    aborted: false,
    thread: null,
};

// 検索条件
window.SearchCondition = {
    targetSkills: [],   // [{kei, minPt}]
    excludeSkills: [],  // [{kei, maxPt}]
    weaponSlot: -1,     // -1=自動, 0-3
    useDecoration: true,
    hunterType: 0,      // 0=両, 1=剣士, 2=ガンナー
    gender: 0,          // 0=両, 1=男, 2=女
    maxResults: 20,
    useExclude: false,
    useOmamori: true,
    matome: false,
    hakkutuAll: false,
    hunterRank: 99,
    villageRank: 99,
    // 除外装備
    excludeEquip: { head:[], body:[], arm:[], wst:[], leg:[], charm:[], deco:[] },
    // 固定装備
    fixedEquip: { head:null, body:null, arm:null, wst:null, leg:null, charm:null },
    // お守りリスト
    charmList: [],
};

// 結果
window.SearchResults = [];
window.AdditionalSkillResults = [];

function getEquipCandidates(part, cond) {
    let list = [...DB.equip[part]];

    // 装備なしを追加
    list.unshift({ part, name:'装備なし', sex:0, type:0, rare:0, slot:0,
        hr:0, mura:0, defInit:0, defMax:0, fire:0, water:0, thunder:0, ice:0, dragon:0, skills:[] });

    // 除外フィルタ
    if (cond.useExclude) {
        const excl = cond.excludeEquip[part] || [];
        list = list.filter(e => !excl.includes(e.name));
    }

    // 固定
    if (cond.fixedEquip[part]) {
        return [cond.fixedEquip[part]];
    }

    // 性別フィルタ
    if (cond.gender !== 0) {
        list = list.filter(e => e.sex === 0 || e.sex === cond.gender);
    }
    // タイプフィルタ
    if (cond.hunterType !== 0) {
        list = list.filter(e => e.type === 0 || e.type === cond.hunterType);
    }

    return list;
}

function getDecoForSlots(slots, cond) {
    // 装飾品を選択してスキルポイントを最大化する
    if (slots <= 0 || !cond.useDecoration) return [];

    let decoList = DB.deco.filter(d => d.slot <= slots);
    if (cond.useExclude) {
        const excl = cond.excludeEquip.deco || [];
        decoList = decoList.filter(d => !excl.includes(d.name));
    }
    return decoList;
}

// 防具のスキル系統ポイントを集計
function sumEquipSkills(equips, charmEntry) {
    const totals = {};
    for (const e of equips) {
        if (!e) continue;
        for (const s of (e.skills || [])) {
            totals[s.kei] = (totals[s.kei] || 0) + s.val;
        }
    }
    // お守り
    if (charmEntry) {
        if (charmEntry.kei1) totals[charmEntry.kei1] = (totals[charmEntry.kei1]||0) + charmEntry.val1;
        if (charmEntry.kei2) totals[charmEntry.kei2] = (totals[charmEntry.kei2]||0) + charmEntry.val2;
    }
    return totals;
}

// 装飾品を最適配置
function optimizeDeco(freeSlots, targetKeis, cond) {
    // 対象スキルに関係する装飾品を優先して配置
    const decoList = DB.deco.filter(d => {
        if (d.slot > freeSlots) return false;
        if (cond.useExclude && (cond.excludeEquip.deco||[]).includes(d.name)) return false;
        if (cond.hunterType !== 0) {
            // タイプフィルタは装飾品に対しては特になし（装飾品自体にタイプはない）
        }
        return true;
    });

    // 貪欲法: 目標スキルに一番効果的な装飾品を選ぶ
    const placed = [];
    let remaining = freeSlots;
    const keiAdded = {};

    // ソート: targetKeis に関係するもの優先
    const sorted = [...decoList].sort((a, b) => {
        const aScore = (targetKeis.includes(a.kei1) ? Math.abs(a.val1) : 0) +
                       (targetKeis.includes(a.kei2) ? Math.abs(a.val2) : 0);
        const bScore = (targetKeis.includes(b.kei1) ? Math.abs(b.val1) : 0) +
                       (targetKeis.includes(b.kei2) ? Math.abs(b.val2) : 0);
        return bScore - aScore;
    });

    for (const d of sorted) {
        if (d.slot > remaining) continue;
        // スロットサイズに応じて何個入るか
        const count = Math.floor(remaining / d.slot);
        if (count <= 0) continue;
        placed.push({ deco: d, count: 1 });
        remaining -= d.slot;
        if (remaining <= 0) break;
    }

    // 装飾品のスキルポイントを合計
    const totals = {};
    for (const { deco, count } of placed) {
        if (deco.kei1) totals[deco.kei1] = (totals[deco.kei1]||0) + deco.val1 * count;
        if (deco.kei2) totals[deco.kei2] = (totals[deco.kei2]||0) + deco.val2 * count;
    }
    return { placed, totals };
}

// 目標スキルを満たすか確認
function meetsTarget(keiTotals, cond) {
    for (const t of cond.targetSkills) {
        const total = keiTotals[t.kei] || 0;
        if (t.pt > 0 && total < t.pt) return false;
        if (t.pt < 0 && total > t.pt) return false;
    }
    return true;
}

// 除外スキルチェック
function hasExcludedSkill(keiTotals, cond) {
    for (const ex of cond.excludeSkills) {
        const total = keiTotals[ex.kei] || 0;
        if (ex.pt < 0 && total <= ex.pt) return true;
    }
    return false;
}

// 合計スロット数を計算
function totalSlots(equips) {
    return equips.reduce((sum, e) => sum + (e ? e.slot : 0), 0);
}

// 検索結果のスコア計算（装備なし数→最終防御力→耐性計）
function calcScore(equips) {
    let noEquip = 0, defTotal = 0, resTotal = 0;
    for (const e of equips) {
        if (!e || e.name === '装備なし') { noEquip++; continue; }
        defTotal += e.defMax || 0;
        resTotal += (e.fire||0) + (e.water||0) + (e.thunder||0) + (e.ice||0) + (e.dragon||0);
    }
    return { noEquip, defTotal, resTotal };
}

// 非同期検索
async function startSearch(cond) {
    SearchState.running = true;
    SearchState.aborted = false;
    SearchResults.length = 0;

    const parts = ['head','body','arm','wst','leg'];
    const candidates = {};
    for (const p of parts) {
        candidates[p] = getEquipCandidates(p, cond);
    }

    // お守りリスト（登録済み + 装備なし）
    const charmCandidates = [null, ...cond.charmList];

    const targetKeis = cond.targetSkills.map(t => t.kei);

    let count = 0;
    let found = 0;

    for (const head of candidates.head) {
        if (SearchState.aborted) break;
        for (const body of candidates.body) {
            if (SearchState.aborted) break;
            for (const arm of candidates.arm) {
                if (SearchState.aborted) break;
                for (const wst of candidates.wst) {
                    for (const leg of candidates.leg) {
                        for (const charm of charmCandidates) {
                            count++;

                            const equips = [head, body, arm, wst, leg];
                            const baseSkills = sumEquipSkills(equips, charm);

                            // 武器スロット
                            let weaponSlots = cond.weaponSlot;
                            if (weaponSlot === -1) {
                                // 自動: スロット0で検索後に増やす
                                weaponSlots = 0;
                            }

                            const freeSlots = totalSlots(equips) + weaponSlots + (charm ? charm.slot : 0);

                            // 装飾品最適化
                            const { placed, totals: decoSkills } = optimizeDeco(freeSlots, targetKeis, cond);

                            // 合計
                            const allSkills = { ...baseSkills };
                            for (const [k, v] of Object.entries(decoSkills)) {
                                allSkills[k] = (allSkills[k] || 0) + v;
                            }

                            if (!meetsTarget(allSkills, cond)) continue;
                            if (hasExcludedSkill(allSkills, cond)) continue;

                            const activatedSkills = calcSkills(allSkills, cond.hunterType || 1);
                            const score = calcScore(equips);

                            SearchResults.push({
                                equips: [...equips],
                                charm,
                                decos: placed,
                                skills: activatedSkills,
                                keiTotals: allSkills,
                                score,
                            });
                            found++;

                            if (found >= cond.maxResults) {
                                SearchState.aborted = true;
                                break;
                            }
                        }
                        if (SearchState.aborted) break;
                    }
                    if (SearchState.aborted) break;
                }
            }
        }

        // UI更新
        if (typeof onSearchProgress === 'function') {
            onSearchProgress(count, found);
        }
        await new Promise(r => setTimeout(r, 0)); // yield
    }

    // 結果ソート
    SearchResults.sort((a, b) => {
        if (a.score.noEquip !== b.score.noEquip) return a.score.noEquip - b.score.noEquip;
        if (a.score.defTotal !== b.score.defTotal) return b.score.defTotal - a.score.defTotal;
        return b.score.resTotal - a.score.resTotal;
    });

    SearchState.running = false;
    if (typeof onSearchComplete === 'function') {
        onSearchComplete(SearchResults);
    }
}

function abortSearch() {
    SearchState.aborted = true;
}
