// search.js - 高速検索エンジン（自動お守り検索＋発掘装備対応版）

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
    autoCharm: false,
};

window.SearchResults = [];
window.AdditionalSkillResults = [];

// ─── ユーティリティ ───

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

    // ── 発掘装備を追加 ──
    if (cond.hakkutuAll && DB.hakkutu && DB.hakkutu.length > 0) {
        const partHakkutu = DB.hakkutu.filter(h => h.part === part);
        // 対象スキルの系統セット
        const targetKeiSet = new Set(cond.targetSkills.map(t => t.kei));
        for (const h of partHakkutu) {
            if (!targetKeiSet.has(h.kei)) continue;
            if (cond.hunterType !== 0 && h.type !== 0 && h.type !== cond.hunterType) continue;
            // スロット0〜3の発掘防具を生成
            for (let slot = 0; slot <= 3; slot++) {
                list.push({
                    part, name: `発掘${['','頭','胴','腕','腰','脚'][['head','body','arm','wst','leg'].indexOf(part)+1]}(${h.kei}+${h.val} ○${slot})`,
                    sex: 0, type: h.type, rare: 8, slot,
                    hr: h.hr, mura: h.mura,
                    defInit: Math.floor(h.defMax * 0.5), defMax: h.defMax,
                    fire: 0, water: 0, thunder: 0, ice: 0, dragon: 0,
                    skills: [{ kei: h.kei, val: h.val }],
                    isHakkutu: true,
                });
            }
        }
    }

    return list;
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

// ── 装飾品最適化（複数枚対応版）──
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
        // ── バグ修正：複数枚配置に対応 ──
        const count = Math.floor(remaining / d.slot);
        if (count <= 0) continue;
        placed.push({ deco: d, count });
        remaining -= d.slot * count;
        if (remaining <= 0) break;
    }

    const totals = {};
    for (const { deco, count } of placed) {
        if (deco.kei1) totals[deco.kei1] = (totals[deco.kei1]||0) + (deco.val1||0) * count;
        if (deco.kei2) totals[deco.kei2] = (totals[deco.kei2]||0) + (deco.val2||0) * count;
    }
    return { placed, totals };
}

// ── 自動お守り検索 ──
function autoSearchCharm(armorSkills, baseSlots, targetKeis, cond) {
    // まず護石なしで試す
    const { placed: placed0, totals: decoSkills0 } = optimizeDeco(baseSlots, targetKeis, cond);
    const allSkills0 = { ...armorSkills };
    for (const [k, v] of Object.entries(decoSkills0)) allSkills0[k] = (allSkills0[k]||0) + v;

    if (meetsTarget(allSkills0, cond)) {
        return { charm: null, placed: placed0, allSkills: allSkills0 };
    }

    // 不足スキルを計算
    const deficits = [];
    for (const t of cond.targetSkills) {
        if (t.pt <= 0) continue;
        const have = allSkills0[t.kei] || 0;
        if (have < t.pt) deficits.push({ kei: t.kei, need: t.pt - have });
    }

    if (deficits.length === 0 || deficits.length > 2) return null;

    // 必要な護石を探索（スロット3→0の順に試して最小スロットで成立するものを採用）
    let bestResult = null;
    for (let slot = 3; slot >= 0; slot--) {
        const charm = {
            kei1: deficits[0].kei,
            val1: Math.min(deficits[0].need, 7),
            kei2: deficits.length > 1 ? deficits[1].kei : '',
            val2: deficits.length > 1 ? Math.min(deficits[1].need, 7) : 0,
            slot,
            name: '必要護石（自動）',
        };

        const charmSkills = {};
        if (charm.kei1) charmSkills[charm.kei1] = charm.val1;
        if (charm.kei2) charmSkills[charm.kei2] = charm.val2;

        const { placed, totals: decoSkills } = optimizeDeco(baseSlots + slot, targetKeis, cond);
        const allSkills = { ...armorSkills };
        for (const [k, v] of Object.entries(charmSkills)) allSkills[k] = (allSkills[k]||0) + v;
        for (const [k, v] of Object.entries(decoSkills)) allSkills[k] = (allSkills[k]||0) + v;

        if (meetsTarget(allSkills, cond)) {
            bestResult = { charm, placed, allSkills };
            // スロットが少ない方が良い護石なので続けて試す
        }
    }
    return bestResult;
}

// ── メイン検索 ──
async function startSearch(cond) {
    SearchState.running = false;
    SearchState.aborted = false;
    SearchResults.length = 0;
    SearchState.running = true;

    const parts = ['head','body','arm','wst','leg'];
    const targetKeis = cond.targetSkills.map(t => t.kei);
    const N = targetKeis.length;

    const keiToIdx = {};
    for (let i = 0; i < N; i++) keiToIdx[targetKeis[i]] = i;
    const targetPts = cond.targetSkills.map(t => t.pt);

    // ── 装飾品スロット効率 ──
    const maxDecoPerSlot = new Float64Array(N);
    if (cond.useDecoration) {
        for (const d of DB.deco) {
            if (d.slot <= 0) continue;
            if (cond.useExclude && (cond.excludeEquip.deco||[]).includes(d.name)) continue;
            const i1 = keiToIdx[d.kei1];
            if (i1 !== undefined && (d.val1||0) > 0)
                maxDecoPerSlot[i1] = Math.max(maxDecoPerSlot[i1], (d.val1||0) / d.slot);
            const i2 = keiToIdx[d.kei2];
            if (i2 !== undefined && (d.val2||0) > 0)
                maxDecoPerSlot[i2] = Math.max(maxDecoPerSlot[i2], (d.val2||0) / d.slot);
        }
    }

    function wrapEquip(e) {
        const skillArr = new Int16Array(N);
        for (const s of (e.skills||[])) {
            const idx = keiToIdx[s.kei];
            if (idx !== undefined) skillArr[idx] += s.val;
        }
        return { eq: e, skillArr, slot: e.slot || 0 };
    }

    function dominancePrune(list) {
        if (list.length <= 20 || N < 2) return list;
        const dominated = new Uint8Array(list.length);
        for (let i = 0; i < list.length; i++) {
            if (dominated[i]) continue;
            const a = list[i];
            for (let j = 0; j < list.length; j++) {
                if (i === j || dominated[j]) continue;
                const b = list[j];
                if (a.slot < b.slot) continue;
                let aDomsB = true;
                for (let k = 0; k < N; k++) {
                    if (a.skillArr[k] < b.skillArr[k]) { aDomsB = false; break; }
                }
                if (aDomsB) dominated[j] = 1;
            }
        }
        return list.filter((_, i) => !dominated[i]);
    }

    const candidates = {};
    const maxPartSkill = {};
    const maxPartSlot = {};

    for (const part of parts) {
        let list = getEquipCandidates(part, cond).map(wrapEquip);

        if (N > 0) {
            list = list.filter(c => {
                if (c.eq.name === '装備なし') return true;
                if (c.slot > 0) return true;
                for (let i = 0; i < N; i++) if (c.skillArr[i] !== 0) return true;
                return false;
            });
        }

        list = dominancePrune(list);

        const maxSkill = new Int32Array(N);
        let maxSlot = 0;
        for (const c of list) {
            for (let i = 0; i < N; i++) if (c.skillArr[i] > maxSkill[i]) maxSkill[i] = c.skillArr[i];
            if (c.slot > maxSlot) maxSlot = c.slot;
        }
        maxPartSkill[part] = maxSkill;
        maxPartSlot[part] = maxSlot;

        list.sort((a, b) => {
            let sa = 0, sb = 0;
            for (let i = 0; i < N; i++) { sa += a.skillArr[i]; sb += b.skillArr[i]; }
            sa += a.slot * 0.5; sb += b.slot * 0.5;
            return sb - sa;
        });

        candidates[part] = list;
    }

    // ── お守り候補 ──
    const isAutoCharm = cond.autoCharm;
    const charmCandidates = [null, ...(cond.charmList || [])];

    // ── canMeet用のお守り最大値 ──
    const maxCharmSkill = new Int32Array(N);
    let maxCharmSlot = 0;

    if (isAutoCharm) {
        // 自動護石検索：最大7ptのスキル×スロット3を仮定（枝刈り用上限）
        for (let i = 0; i < N; i++) maxCharmSkill[i] = 7;
        maxCharmSlot = 3;
    } else {
        for (const c of charmCandidates) {
            if (!c) continue;
            const i1 = keiToIdx[c.kei1];
            if (i1 !== undefined && (c.val1||0) > maxCharmSkill[i1]) maxCharmSkill[i1] = c.val1||0;
            const i2 = keiToIdx[c.kei2];
            if (i2 !== undefined && (c.val2||0) > maxCharmSkill[i2]) maxCharmSkill[i2] = c.val2||0;
            if ((c.slot||0) > maxCharmSlot) maxCharmSlot = c.slot||0;
        }
    }

    const weaponSlotActual = (cond.weaponSlot === -1) ? 0 : Math.max(0, cond.weaponSlot);
    const weaponSlotUpper  = (cond.weaponSlot === -1) ? 3 : weaponSlotActual;

    const suffixMaxSlot = new Int32Array(parts.length + 1);
    for (let i = parts.length - 1; i >= 0; i--) {
        suffixMaxSlot[i] = suffixMaxSlot[i + 1] + maxPartSlot[parts[i]];
    }

    const suffixMaxSkill = new Array(parts.length + 1);
    suffixMaxSkill[parts.length] = new Int32Array(N);
    for (let i = parts.length - 1; i >= 0; i--) {
        const arr = new Int32Array(N);
        for (let k = 0; k < N; k++) {
            arr[k] = suffixMaxSkill[i + 1][k] + maxPartSkill[parts[i]][k];
        }
        suffixMaxSkill[i] = arr;
    }

    const cur = new Int32Array(N);

    function canMeet(remainIdx) {
        const slotCap = suffixMaxSlot[remainIdx] + maxCharmSlot + weaponSlotUpper;
        let slotDemand = 0;
        const suf = suffixMaxSkill[remainIdx];
        for (let i = 0; i < N; i++) {
            const tgt = targetPts[i];
            if (tgt <= 0) continue;
            const skillUpper = cur[i] + suf[i] + maxCharmSkill[i];
            const deficit = tgt - skillUpper;
            if (deficit <= 0) continue;
            if (!cond.useDecoration || maxDecoPerSlot[i] === 0) return false;
            slotDemand += deficit / maxDecoPerSlot[i];
            if (slotDemand > slotCap) return false;
        }
        return true;
    }

    // ── メイン検索ループ ──
    let found = 0;
    let count = 0;
    let lastYield = Date.now();

    for (const headC of candidates.head) {
        if (SearchState.aborted) break;
        for (let i = 0; i < N; i++) cur[i] += headC.skillArr[i];

        if (canMeet(1)) {
            for (const bodyC of candidates.body) {
                if (SearchState.aborted) break;
                for (let i = 0; i < N; i++) cur[i] += bodyC.skillArr[i];

                if (canMeet(2)) {
                    for (const armC of candidates.arm) {
                        if (SearchState.aborted) break;
                        for (let i = 0; i < N; i++) cur[i] += armC.skillArr[i];

                        if (canMeet(3)) {
                            for (const wstC of candidates.wst) {
                                if (SearchState.aborted) break;
                                for (let i = 0; i < N; i++) cur[i] += wstC.skillArr[i];

                                if (canMeet(4)) {
                                    for (const legC of candidates.leg) {
                                        if (SearchState.aborted) break;
                                        count++;
                                        for (let i = 0; i < N; i++) cur[i] += legC.skillArr[i];

                                        const baseSlots = headC.slot + bodyC.slot + armC.slot
                                                        + wstC.slot + legC.slot + weaponSlotActual;
                                        const equips = [headC.eq, bodyC.eq, armC.eq, wstC.eq, legC.eq];

                                        // ── 自動護石 or 手動護石リスト ──
                                        if (isAutoCharm) {
                                            // 装備のスキル合計を計算
                                            const armorSkills = {};
                                            for (const eq of equips) {
                                                for (const s of (eq.skills||[])) {
                                                    armorSkills[s.kei] = (armorSkills[s.kei]||0) + s.val;
                                                }
                                            }

                                            const res = autoSearchCharm(armorSkills, baseSlots, targetKeis, cond);
                                            if (res && !hasExcludedSkill(res.allSkills, cond)) {
                                                const hunterType = cond.hunterType || 1;
                                                const activatedSkills = calcSkills(res.allSkills, hunterType);
                                                const score = calcScore(equips);
                                                SearchResults.push({
                                                    equips: [...equips],
                                                    charm: res.charm,
                                                    decos: res.placed,
                                                    skills: activatedSkills,
                                                    keiTotals: res.allSkills,
                                                    score,
                                                    autoCharm: res.charm !== null,
                                                });
                                                found++;
                                                if (found >= cond.maxResults) {
                                                    SearchState.aborted = true;
                                                }
                                            }
                                        } else {
                                            // 手動護石リストを使用（元の処理）
                                            for (const charm of charmCandidates) {
                                                if (SearchState.aborted) break;

                                                const freeSlots = baseSlots + (charm ? (charm.slot||0) : 0);
                                                const { placed, totals: decoSkills } = optimizeDeco(
                                                    freeSlots, targetKeis, cond
                                                );

                                                const allSkills = {};
                                                for (const eq of equips) {
                                                    for (const s of (eq.skills||[])) {
                                                        allSkills[s.kei] = (allSkills[s.kei]||0) + s.val;
                                                    }
                                                }
                                                if (charm) {
                                                    if (charm.kei1) allSkills[charm.kei1] = (allSkills[charm.kei1]||0) + (charm.val1||0);
                                                    if (charm.kei2) allSkills[charm.kei2] = (allSkills[charm.kei2]||0) + (charm.val2||0);
                                                }
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

                                        for (let i = 0; i < N; i++) cur[i] -= legC.skillArr[i];
                                    }
                                }
                                for (let i = 0; i < N; i++) cur[i] -= wstC.skillArr[i];
                            }
                        }
                        for (let i = 0; i < N; i++) cur[i] -= armC.skillArr[i];
                    }
                }
                for (let i = 0; i < N; i++) cur[i] -= bodyC.skillArr[i];
            }
        }
        for (let i = 0; i < N; i++) cur[i] -= headC.skillArr[i];

        if (typeof onSearchProgress === 'function') onSearchProgress(count, found);
        const now = Date.now();
        if (now - lastYield > 16) {
            await new Promise(r => setTimeout(r, 0));
            lastYield = now;
        }
    }

    SearchResults.sort((a, b) => {
        if (a.score.noEquip !== b.score.noEquip) return a.score.noEquip - b.score.noEquip;
        if (a.score.defTotal !== b.score.defTotal) return b.score.defTotal - a.score.defTotal;
        return b.score.resTotal - a.score.resTotal;
    });

    SearchState.running = false;
    if (typeof onSearchComplete === 'function') onSearchComplete(SearchResults);
}

function abortSearch() { SearchState.aborted = true; }
