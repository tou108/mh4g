// search.js - 超高速スキルシミュレータ検索エンジン (最適化版)
// 最適化内容:
//   1. 各ネストレベルで上界枝刈り (不可能な組み合わせを一括スキップ)
//   2. 装飾品選択のプリキャッシュ (毎ループのソートを排除)
//   3. スキルマップ事前計算 (_skillMap) で配列走査を廃止
//   4. buildSkillMap() のキャッシュ化
//   5. 有望候補を優先ソートして早期終了率を向上

window.SearchState = { running: false, aborted: false };
window.SearchResults = [];

// ---- calcSkills 高速化: buildSkillMap をキャッシュ ----
let _cachedSkillMap = null;
function getCachedSkillMap() {
    if (!_cachedSkillMap) {
        _cachedSkillMap = {};
        for (const s of DB.skills) {
            if (!_cachedSkillMap[s.kei]) _cachedSkillMap[s.kei] = [];
            _cachedSkillMap[s.kei].push(s);
        }
    }
    return _cachedSkillMap;
}

function calcSkills(keiTotals, type) {
    const skillMap = getCachedSkillMap();
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

function getEquipCandidates(part, cond) {
    let list = [...DB.equip[part]];
    list.unshift({ part, name:'装備なし', sex:0, type:0, rare:0, slot:0,
        hr:0, mura:0, defInit:0, defMax:0, fire:0, water:0, thunder:0, ice:0, dragon:0, skills:[] });
    if (cond.useExclude) {
        const excl = cond.excludeEquip[part] || [];
        list = list.filter(e => !excl.includes(e.name));
    }
    if (cond.fixedEquip[part]) return [cond.fixedEquip[part]];
    if (cond.gender !== 0) list = list.filter(e => e.sex === 0 || e.sex === cond.gender);
    if (cond.hunterType !== 0) list = list.filter(e => e.type === 0 || e.type === cond.hunterType);
    return list;
}

function sumEquipSkills(equips, charmEntry) {
    const totals = {};
    for (const e of equips) {
        if (!e) continue;
        for (const s of (e.skills || [])) {
            totals[s.kei] = (totals[s.kei] || 0) + s.val;
        }
    }
    if (charmEntry) {
        if (charmEntry.kei1) totals[charmEntry.kei1] = (totals[charmEntry.kei1]||0) + charmEntry.val1;
        if (charmEntry.kei2) totals[charmEntry.kei2] = (totals[charmEntry.kei2]||0) + charmEntry.val2;
    }
    return totals;
}

function optimizeDeco(freeSlots, targetKeis, cond) {
    const decoList = DB.deco.filter(d => {
        if (d.slot > freeSlots) return false;
        if (!cond.useDecoration) return false;
        if (cond.useExclude && (cond.excludeEquip.deco||[]).includes(d.name)) return false;
        return true;
    });
    const placed = [];
    let remaining = freeSlots;
    const sorted = [...decoList].sort((a, b) => {
        const aScore = (targetKeis.includes(a.kei1) ? Math.abs(a.val1) : 0) +
                       (targetKeis.includes(a.kei2) ? Math.abs(a.val2) : 0);
        const bScore = (targetKeis.includes(b.kei1) ? Math.abs(b.val1) : 0) +
                       (targetKeis.includes(b.kei2) ? Math.abs(b.val2) : 0);
        return bScore - aScore;
    });
    for (const d of sorted) {
        if (d.slot > remaining) continue;
        placed.push({ deco: d, count: 1 });
        remaining -= d.slot;
        if (remaining <= 0) break;
    }
    const totals = {};
    for (const { deco, count } of placed) {
        if (deco.kei1) totals[deco.kei1] = (totals[deco.kei1]||0) + deco.val1 * count;
        if (deco.kei2) totals[deco.kei2] = (totals[deco.kei2]||0) + deco.val2 * count;
    }
    return { placed, totals };
}

function meetsTarget(keiTotals, cond) {
    for (const t of cond.targetSkills) {
        const total = keiTotals[t.kei] || 0;
        if (t.pt > 0 && total < t.pt) return false;
        if (t.pt < 0 && total > t.pt) return false;
    }
    return true;
}

function hasExcludedSkill(keiTotals, cond) {
    for (const ex of cond.excludeSkills) {
        const total = keiTotals[ex.kei] || 0;
        if (ex.pt < 0 && total <= ex.pt) return true;
    }
    return false;
}

function totalSlots(equips) {
    return equips.reduce((sum, e) => sum + (e ? e.slot : 0), 0);
}

function calcScore(equips) {
    let noEquip = 0, defTotal = 0, resTotal = 0;
    for (const e of equips) {
        if (!e || e.name === '装備なし') { noEquip++; continue; }
        defTotal += e.defMax || 0;
        resTotal += (e.fire||0) + (e.water||0) + (e.thunder||0) + (e.ice||0) + (e.dragon||0);
    }
    return { noEquip, defTotal, resTotal };
}

// ========== 超高速検索エンジン ==========
async function startSearch(cond) {
    SearchState.running = true;
    SearchState.aborted = false;
    SearchResults.length = 0;
    _cachedSkillMap = null; // リセット

    const parts = ['head', 'body', 'arm', 'wst', 'leg'];
    const targetKeis = cond.targetSkills.map(t => t.kei);

    // 関連するスキル系統 (目標 + 除外) を列挙
    const excludeKeis = cond.excludeSkills.map(ex => ex.kei);
    const allKeis = [...new Set([...targetKeis, ...excludeKeis])];

    // 目標スキルのポイントマップ
    const targetPt = {};
    for (const t of cond.targetSkills) targetPt[t.kei] = t.pt;

    // --- 候補リスト取得 ---
    const partCandidates = parts.map(p => getEquipCandidates(p, cond));
    const charmCandidates = [null, ...cond.charmList];

    // --- 最適化1: 各防具に _skillMap を事前計算 ---
    for (const pc of partCandidates) {
        for (const e of pc) {
            if (!e._skillMap) {
                const m = {};
                for (const s of (e.skills || [])) {
                    m[s.kei] = (m[s.kei] || 0) + s.val;
                }
                e._skillMap = m;
            }
        }
    }

    // --- 最適化2: 装飾品プリキャッシュ (スロット数0..21) ---
    const MAX_SLOTS = 21; // 5部位×3 + 武器3 + 護石3
    const decoCache = [];
    for (let s = 0; s <= MAX_SLOTS; s++) {
        decoCache.push(optimizeDeco(s, targetKeis, cond));
    }

    // --- 最適化3: 各部位のスキル上界を計算 ---
    // maxContrib[i][kei] = 部位iで得られる最大スキル値
    const maxContrib = partCandidates.map(pc => {
        const m = {};
        for (const kei of targetKeis) {
            let best = 0;
            for (const e of pc) {
                const v = e._skillMap[kei] || 0;
                if (v > best) best = v;
            }
            m[kei] = best;
        }
        return m;
    });

    // 護石の上界
    const maxCharmContrib = {};
    for (const kei of targetKeis) {
        let best = 0;
        for (const c of charmCandidates) {
            if (!c) continue;
            if (c.kei1 === kei && c.val1 > best) best = c.val1;
            if (c.kei2 === kei && c.val2 > best) best = c.val2;
        }
        maxCharmContrib[kei] = best;
    }

    // 各部位の最大スロット数
    const maxSlotPer = partCandidates.map(pc => Math.max(0, ...pc.map(e => e.slot || 0)));
    const weaponSlots = cond.weaponSlot === -1 ? 0 : (cond.weaponSlot || 0);
    const maxCharmSlot = charmCandidates.reduce((m, c) => Math.max(m, c ? (c.slot || 0) : 0), 0);

    // 装飾品の最大スキル貢献率 (スロットあたり)
    const maxDecoPerSlot = {};
    if (cond.useDecoration) {
        for (const kei of targetKeis) {
            let best = 0;
            for (const d of DB.deco) {
                if (cond.useExclude && (cond.excludeEquip.deco||[]).includes(d.name)) continue;
                let val = 0;
                if (d.kei1 === kei) val += d.val1 || 0;
                if (d.kei2 === kei) val += d.val2 || 0;
                if (val > 0 && d.slot > 0) best = Math.max(best, val / d.slot);
            }
            maxDecoPerSlot[kei] = best;
        }
    }

    // --- 最適化4: 有望候補を優先ソート (早期終了率アップ) ---
    for (let i = 0; i < 5; i++) {
        partCandidates[i].sort((a, b) => {
            let sa = 0, sb = 0;
            for (const kei of targetKeis) {
                const ta = targetPt[kei] || 0;
                if (ta > 0) {
                    sa += a._skillMap[kei] || 0;
                    sb += b._skillMap[kei] || 0;
                }
            }
            sa += (a.slot || 0) * 1.5;
            sb += (b.slot || 0) * 1.5;
            return sb - sa;
        });
    }

    // --- 上界チェック関数 ---
    // 現在の累積スキル・スロット + 残り部位の最大寄与で目標を達成できるか？
    function canReach(acc, accSlots, fromIdx, withCharm) {
        for (const kei of targetKeis) {
            const need = targetPt[kei];
            if (!need || need <= 0) continue; // 負目標は保守的にスキップ

            let pot = acc[kei] || 0;
            for (let i = fromIdx; i < 5; i++) pot += maxContrib[i][kei] || 0;
            if (withCharm) pot += maxCharmContrib[kei] || 0;

            // スロット上界
            let potSlots = accSlots;
            for (let i = fromIdx; i < 5; i++) potSlots += maxSlotPer[i];
            if (withCharm) potSlots += maxCharmSlot;
            pot += (maxDecoPerSlot[kei] || 0) * potSlots;

            if (pot < need) return false; // この枝は絶対に届かない → 枝刈り
        }
        return true;
    }

    // --- メインループ ---
    let count = 0;
    let found = 0;

    const [headList, bodyList, armList, wstList, legList] = partCandidates;

    mainLoop:
    for (const head of headList) {
        if (SearchState.aborted) break;

        // head のスキル累積
        const sk0 = {};
        for (const kei of allKeis) { const v = head._skillMap[kei]; if (v) sk0[kei] = v; }
        const sl0 = (head.slot || 0) + weaponSlots;

        if (!canReach(sk0, sl0, 1, true)) continue; // 枝刈り

        for (const body of bodyList) {
            if (SearchState.aborted) break mainLoop;

            const sk1 = { ...sk0 };
            for (const kei of allKeis) { const v = body._skillMap[kei]; if (v) sk1[kei] = (sk1[kei] || 0) + v; }
            const sl1 = sl0 + (body.slot || 0);

            if (!canReach(sk1, sl1, 2, true)) continue;

            for (const arm of armList) {
                if (SearchState.aborted) break mainLoop;

                const sk2 = { ...sk1 };
                for (const kei of allKeis) { const v = arm._skillMap[kei]; if (v) sk2[kei] = (sk2[kei] || 0) + v; }
                const sl2 = sl1 + (arm.slot || 0);

                if (!canReach(sk2, sl2, 3, true)) continue;

                for (const wst of wstList) {
                    if (SearchState.aborted) break mainLoop;

                    const sk3 = { ...sk2 };
                    for (const kei of allKeis) { const v = wst._skillMap[kei]; if (v) sk3[kei] = (sk3[kei] || 0) + v; }
                    const sl3 = sl2 + (wst.slot || 0);

                    if (!canReach(sk3, sl3, 4, true)) continue;

                    for (const leg of legList) {
                        if (SearchState.aborted) break mainLoop;

                        const sk4 = { ...sk3 };
                        for (const kei of allKeis) { const v = leg._skillMap[kei]; if (v) sk4[kei] = (sk4[kei] || 0) + v; }
                        const sl4 = sl3 + (leg.slot || 0);

                        if (!canReach(sk4, sl4, 5, true)) continue;

                        // 防具5部位が確定。各護石を試す。
                        for (const charm of charmCandidates) {
                            count++;

                            // 護石スキル加算 (コピー不要: sk4 は変えない)
                            let ck1 = 0, ck2 = 0;
                            const sk5 = { ...sk4 };
                            if (charm) {
                                if (charm.kei1) { sk5[charm.kei1] = (sk5[charm.kei1] || 0) + charm.val1; }
                                if (charm.kei2) { sk5[charm.kei2] = (sk5[charm.kei2] || 0) + charm.val2; }
                            }
                            const freeSlots = sl4 + (charm ? (charm.slot || 0) : 0);

                            // プリキャッシュから装飾品取得
                            const { placed, totals: decoSkills } = decoCache[Math.min(freeSlots, MAX_SLOTS)];

                            const allSkills = { ...sk5 };
                            for (const [k, v] of Object.entries(decoSkills)) {
                                allSkills[k] = (allSkills[k] || 0) + v;
                            }

                            if (!meetsTarget(allSkills, cond)) continue;
                            if (hasExcludedSkill(allSkills, cond)) continue;

                            const equips = [head, body, arm, wst, leg];
                            const activatedSkills = calcSkills(allSkills, cond.hunterType || 1);
                            const score = calcScore(equips);

                            SearchResults.push({
                                equips,
                                charm, decos: placed,
                                skills: activatedSkills,
                                keiTotals: allSkills, score,
                            });
                            found++;

                            if (found >= cond.maxResults) {
                                SearchState.aborted = true;
                                break;
                            }
                        }
                        if (SearchState.aborted) break mainLoop;
                    }
                }
            }
        }

        if (typeof onSearchProgress === 'function') onSearchProgress(count, found);
        await new Promise(r => setTimeout(r, 0));
    }

    SearchResults.sort((a, b) => {
        if (a.score.noEquip !== b.score.noEquip) return a.score.noEquip - b.score.noEquip;
        if (a.score.defTotal !== b.score.defTotal) return b.score.defTotal - a.score.defTotal;
        return b.score.resTotal - a.score.resTotal;
    });

    SearchState.running = false;
    if (typeof onSearchComplete === 'function') onSearchComplete(SearchResults);
}

function abortSearch() {
    SearchState.aborted = true;
}
