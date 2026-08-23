export type FusedHit = {
  id: number;
  score: number;
};

const DEFAULT_RRF_K = 60;

export function reciprocalRankFusion(rankLists: number[][], k = DEFAULT_RRF_K): FusedHit[] {
  const scores = new Map<number, number>();
  for (const list of rankLists) {
    for (const [index, id] of list.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
