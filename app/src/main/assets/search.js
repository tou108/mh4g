// search.js - 超高速検索エンジン（枝刈り最適化版）

window.SearchState = { running: false, aborted: false };

window.SearchCondition = {
    targetSkills: [], excludeSkills: [],
    weaponSlot: -1, useDecoration: true,
    hunterType: 0, gender: 0, maxResults: 20,
    useExclude: false, useOmamori: true, matome: false, hakkutuAll: false,
    hunterRank: 99, villageRank: 99,
    excludeEquip: { head:[], body:[], arm:[], wst:[], leg:[], charm:[], deco:[] },
    fixedEquip: { head:null, body:null, arm:null, wst:null, leg:null, charm:null },
    charmList: [],
};

window.SearchResults = [];
window.AdditionalSkillResults = [];

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

function optimizeDeco(freeSlots, targetKeis, cond) {
    if (freeSlots <= 0 || !cond.useDecoration) return { placed: [], totals: {} };
    let decoList = DB.deco.filter(d => {
        if (d.slot > freeSlots) return false;
        if (cond.useExclude && (cond.excludeEquip.deco||[]).includes(d.name)) return false;
        return true;
    });
    const sorted = [...decoList].sort((a, b) => {
        const aScore = (targetKeis.includes(a.kei1) ? Math.abs(a.val1||0) : 0) +
                       (targetKeis.includes(a.kei2) ? Math.abs(a.val2||0) : 0);
        const bScore = (targetKeis.includes(b.kei1) ? Math.abs(b.val1||0) : 0) +
                       (targetKeis.includes(b.kei2) ? Math.abs(b.val2||0) : 0);
        return bScore - aScore;
    });
    const placed = [];
    let remaining = freeSlots;
    for (const d of sorted) {
        if (d.slot > remaining) continue;
        placed.push({ deco: d, count: 1 });
        remaining -= d.slot;
        if (remaining <= 0) break;
    }
    const totals = {};
    for (const { deco } of placed) {
        if (deco.kei1) totals[deco.kei1] = (totals[deco.kei1]||0) + (deco.val1||0);
        if (deco.kei2) totals[deco.kei2] = (totals[deco.kei2]||0) + (deco.val2||0);
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
    return equips.reduce((sum, e) => sum + (e ? (e.slot||0) : 0), 0);
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

// スキルポイントを加算（高速版）
function addEquipSkills(base, e, charm) {
    const result = { ...base };
    if (e) {
        for (const s of (e.skills||[])) {
            result[s.kei] = (result[s.kei]||0) + s.val;
        }
    }
    if (charm) {
        if (charm.kei1) result[charm.kei1] = (result[charm.kei1]||0) + (charm.val1||0);
        if (charm.kei2) result[charm.kei2] = (result[charm.kei2]||0) + (charm.val2||0);
    }
    return result;
}

async function startSearch(cond) {
    SearchState.running = true;
    SearchState.aborted = false;
    SearchResults.length = 0;

    const parts = ['head','body','arm','wst','leg'];
    const targetKeis = cond.targetSkills.map(t => t.kei);
    const targetMap = {};
    for (const t of cond.targetSkills) targetMap[t.kei] = t.pt;

    // ── 1. 装飾品から各系統の最大スロット効率を事前計算 ──
    const maxDecoPerSlot = {}; // kei -> val per 1 slot unit
    for (const kei of targetKeis) {
        maxDecoPerSlot[kei] = 0;
        for (const d of DB.deco) {
            if (cond.useExclude && (cond.excludeEquip.deco||[]).includes(d.name)) continue;
            if (d.slot <= 0) continue;
            const val = (d.kei1 === kei ? (d.val1||0) : 0) + (d.kei2 === kei ? (d.val2||0) : 0);
            if (val > 0) maxDecoPerSlot[kei] = Math.max(maxDecoPerSlot[kei], val / d.slot);
        }
    }

    // 装備が系統Kに最大どれだけ貢献できるか（スキル＋スロット）
    function equipMaxForKei(e, kei) {
        if (!e) return 0;
        const base = (e.skills||[]).reduce((s, sk) => s + (sk.kei === kei ? sk.val : 0), 0);
        const slotBonus = (e.slot||0) * (maxDecoPerSlot[kei] || 0);
        return base + slotBonus;
    }

    // ── 2. 各部位の候補をフィルタ＋ソート ──
    const candidates = {};
    for (const part of parts) {
        let list = getEquipCandidates(part, cond);
        // 無関係な装備を除外（対象スキルに貢献できない装備）
        if (targetKeis.length > 0) {
            list = list.filter(e => {
                if (e.name === '装備なし') return true;
                if ((e.slot||0) > 0 && targetKeis.some(k => maxDecoPerSlot[k] > 0)) return true;
                return (e.skills||[]).some(s => targetKeis.includes(s.kei));
            });
        }
        // 関連度順にソート（高いものが先）
        list.sort((a, b) => {
            let sa = 0, sb = 0;
            for (const k of targetKeis) {
                sa += equipMaxForKei(a, k);
                sb += equipMaxForKei(b, k);
            }
            return sb - sa;
        });
        candidates[part] = list;
    }

    // ── 3. 各部位の最大貢献を事前計算（枝刈り用） ──
    const maxPartKei = {};
    for (const part of parts) {
        maxPartKei[part] = {};
        for (const kei of targetKeis) {
            let best = 0;
            for (const e of candidates[part]) best = Math.max(best, equipMaxForKei(e, kei));
            maxPartKei[part][kei] = best;
        }
    }

    // お守り候補
    const charmCandidates = [null, ...cond.charmList];
    const maxCharmKei = {};
    for (const kei of targetKeis) {
        maxCharmKei[kei] = 0;
        for (const c of charmCandidates) {
            if (!c) continue;
            const val = (c.kei1 === kei ? (c.val1||0) : 0) + (c.kei2 === kei ? (c.val2||0) : 0);
            const slotBonus = (c.slot||0) * (maxDecoPerSlot[kei] || 0);
            maxCharmKei[kei] = Math.max(maxCharmKei[kei], val + slotBonus);
        }
    }

    // 武器スロット（-1=自動は上限3でUpperBound計算、実際は0）
    const weaponSlotActual = (cond.weaponSlot === -1) ? 0 : Math.max(0, cond.weaponSlot);
    const weaponSlotUpper = (cond.weaponSlot === -1) ? 3 : weaponSlotActual;
    const maxWeaponKei = {};
    for (const kei of targetKeis) {
        maxWeaponKei[kei] = weaponSlotUpper * (maxDecoPerSlot[kei] || 0);
    }

    // ── 枝刈り判定：残りの部位でターゲットを達成可能か？ ──
    function canMeet(cur, remainParts) {
        for (const kei of targetKeis) {
            const tgt = targetMap[kei];
            if (!tgt || tgt <= 0) continue;
            let upper = cur[kei] || 0;
            for (const p of remainParts) upper += maxPartKei[p][kei] || 0;
            upper += maxCharmKei[kei] || 0;
            upper += maxWeaponKei[kei] || 0;
            if (upper < tgt) return false;
        }
        return true;
    }

    let found = 0;
    let count = 0;
    let lastYield = Date.now();

    // ── メイン検索ループ（5段階の枝刈り） ──
    for (const head of candidates.head) {
        if (SearchState.aborted) break;

        const k1 = {};
        for (const s of (head.skills||[])) k1[s.kei] = (k1[s.kei]||0) + s.val;
        if (!canMeet(k1, ['body','arm','wst','leg'])) { count++; continue; }

        for (const body of candidates.body) {
            if (SearchState.aborted) break;

            const k2 = { ...k1 };
            for (const s of (body.skills||[])) k2[s.kei] = (k2[s.kei]||0) + s.val;
            if (!canMeet(k2, ['arm','wst','leg'])) { count++; continue; }

            for (const arm of candidates.arm) {
                if (SearchState.aborted) break;

                const k3 = { ...k2 };
                for (const s of (arm.skills||[])) k3[s.kei] = (k3[s.kei]||0) + s.val;
                if (!canMeet(k3, ['wst','leg'])) { count++; continue; }

                for (const wst of candidates.wst) {
                    if (SearchState.aborted) break;

                    const k4 = { ...k3 };
                    for (const s of (wst.skills||[])) k4[s.kei] = (k4[s.kei]||0) + s.val;
                    if (!canMeet(k4, ['leg'])) { count++; continue; }

                    for (const leg of candidates.leg) {
                        if (SearchState.aborted) break;
                        count++;

                        const k5 = { ...k4 };
                        for (const s of (leg.skills||[])) k5[s.kei] = (k5[s.kei]||0) + s.val;
                        if (!canMeet(k5, [])) continue;

                        const equips = [head, body, arm, wst, leg];
                        const baseSlots = totalSlots(equips) + weaponSlotActual;

                        for (const charm of charmCandidates) {
                            if (SearchState.aborted) break;

                            const baseSkills = { ...k5 };
                            if (charm) {
                                if (charm.kei1) baseSkills[charm.kei1] = (baseSkills[charm.kei1]||0) + (charm.val1||0);
                                if (charm.kei2) baseSkills[charm.kei2] = (baseSkills[charm.kei2]||0) + (charm.val2||0);
                            }

                            const freeSlots = baseSlots + (charm ? (charm.slot||0) : 0);
                            const { placed, totals: decoSkills } = optimizeDeco(freeSlots, targetKeis, cond);

                            const allSkills = { ...baseSkills };
                            for (const [k, v] of Object.entries(decoSkills)) {
                                allSkills[k] = (allSkills[k]||0) + v;
                            }

                            if (!meetsTarget(allSkills, cond)) continue;
                            if (hasExcludedSkill(allSkills, cond)) continue;

                            const hunterType = cond.hunterType || 1;
                            const activatedSkills = calcSkills(allSkills, hunterType);
                            const score = calcScore(equips);

                            SearchResults.push({
                                equips: [...equips], charm, decos: placed,
                                skills: activatedSkills, keiTotals: allSkills, score,
                            });
                            found++;

                            if (found >= cond.maxResults) {
                                SearchState.aborted = true;
                                break;
                            }
                        }
                    }
                }
            }
        }

        // 進捗報告（headループ毎＋時間経過毎）
        if (typeof onSearchProgress === 'function') onSearchProgress(count, found);
        const now = Date.now();
        if (now - lastYield > 16) { // ~60fps
            await new Promise(r => setTimeout(r, 0));
            lastYield = now;
        }
    }

    // 結果ソート
    SearchResults.sort((a, b) => {
        if (a.score.noEquip !== b.score.noEquip) return a.score.noEquip - b.score.noEquip;
        if (a.score.defTotal !== b.score.defTotal) return b.score.defTotal - a.score.defTotal;
        return b.score.resTotal - a.score.resTotal;
    });

    SearchState.running = false;
    if (typeof onSearchComplete === 'function') onSearchComplete(SearchResults);
}

function abortSearch() { SearchState.aborted = true; }
