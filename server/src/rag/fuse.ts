type FusedHit = {
  id: number;
  score: number;
};

const DEFAULT_RRF_K = 60;

export function reciprocalRankFusion(rankLists: number[][]): FusedHit[] {
  const scores = new Map<number, number>();
  for (const list of rankLists) {
    for (const [index, id] of list.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (DEFAULT_RRF_K + index + 1));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id, score]) => ({ id, score }));
}
