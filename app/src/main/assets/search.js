// search.js - 高速検索エンジン（スロット共有対応の厳密枝刈り版）
//
// ====== 旧版の問題点と修正内容 ======
//
// 【問題1：最重要バグ】スロット貢献を各スキルに独立カウントしていた
//   旧 canMeet: 各スキルkに対し「残りスロット全部をスキルkに使える」と仮定。
//   スキルが5個あると実際3スロットなのに「5スキル×3スロット分」を期待するため
//   枝刈りが全く効かなくなる。
//
//   修正: 「全スキルの不足分を補うのに必要なスロット合計」≤「実際のスロット上限」
//         という正しい条件で枝刈りする。
//
// 【問題2】各ループでオブジェクトスプレッド { ...k2 } を大量生成していた
//   修正: 累積スキルを Int32Array で管理し、加算/減算のみで更新する。
//
// 【問題3】スキル数が多い時に候補リストが絞り込めていなかった
//   修正: 支配関係（全スキルで劣り、スロット数も同等以下）による事前除外を追加。

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

// ─── ユーティリティ（変更なし） ───

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

// ─── メイン検索 ───

async function startSearch(cond) {
    SearchState.running = true;
    SearchState.aborted = false;
    SearchResults.length = 0;

    const parts = ['head','body','arm','wst','leg'];
    const targetKeis = cond.targetSkills.map(t => t.kei);
    const N = targetKeis.length;

    // スキル系統 → インデックス変換
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

    // ── 装備を整数配列でラップ ──
    function wrapEquip(e) {
        const skillArr = new Int16Array(N);
        for (const s of (e.skills||[])) {
            const idx = keiToIdx[s.kei];
            if (idx !== undefined) skillArr[idx] += s.val;
        }
        return { eq: e, skillArr, slot: e.slot || 0 };
    }

    // ── 支配関係による候補除外 ──
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

    // ── 各部位の候補リスト構築 ──
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
    const charmCandidates = [null, ...(cond.charmList || [])];
    const maxCharmSkill = new Int32Array(N);
    let maxCharmSlot = 0;
    for (const c of charmCandidates) {
        if (!c) continue;
        const i1 = keiToIdx[c.kei1];
        if (i1 !== undefined && (c.val1||0) > maxCharmSkill[i1]) maxCharmSkill[i1] = c.val1||0;
        const i2 = keiToIdx[c.kei2];
        if (i2 !== undefined && (c.val2||0) > maxCharmSkill[i2]) maxCharmSkill[i2] = c.val2||0;
        if ((c.slot||0) > maxCharmSlot) maxCharmSlot = c.slot||0;
    }

    const weaponSlotActual = (cond.weaponSlot === -1) ? 0 : Math.max(0, cond.weaponSlot);
    const weaponSlotUpper  = (cond.weaponSlot === -1) ? 3 : weaponSlotActual;

    // ── サフィックス事前計算 ──
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

    // ── 改良版枝刈り ──
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

                                        for (const charm of charmCandidates) {
                                            if (SearchState.aborted) break;

                                            const freeSlots = baseSlots + (charm ? (charm.slot||0) : 0);
                                            const { placed, totals: decoSkills } = optimizeDeco(
                                                freeSlots, targetKeis, cond
                                            );

                                            const allSkills = {};
                                            const equips = [headC.eq, bodyC.eq, armC.eq, wstC.eq, legC.eq];
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
