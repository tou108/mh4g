// search.js - スキルシミュレータ検索エンジン

window.SearchState = { running: false, aborted: false };
window.SearchResults = [];

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

// ★ バグ修正: weaponSlot → cond.weaponSlot
async function startSearch(cond) {
    SearchState.running = true;
    SearchState.aborted = false;
    SearchResults.length = 0;

    const parts = ['head','body','arm','wst','leg'];
    const candidates = {};
    for (const p of parts) candidates[p] = getEquipCandidates(p, cond);

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

                            // ★ 修正: cond.weaponSlot を使う
                            let weaponSlots = cond.weaponSlot;
                            if (cond.weaponSlot === -1) weaponSlots = 0;

                            const freeSlots = totalSlots(equips) + weaponSlots + (charm ? charm.slot : 0);
                            const { placed, totals: decoSkills } = optimizeDeco(freeSlots, targetKeis, cond);

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
                        if (SearchState.aborted) break;
                    }
                    if (SearchState.aborted) break;
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
