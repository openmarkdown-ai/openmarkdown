/** Simple word-level diff for previews: [op, text] with op -1 removed, 0 same, 1 added. */
export function wordDiff(a: string, b: string): [number, string][] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  if (A.length * B.length > 4_000_000) return [[-1, a], [1, b]];
  const dp: Uint16Array[] = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: [number, string][] = [];
  const push = (op: number, s: string) => {
    const last = out[out.length - 1];
    if (last && last[0] === op) last[1] += s;
    else out.push([op, s]);
  };
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      push(0, A[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push(-1, A[i++]!);
    else push(1, B[j++]!);
  }
  while (i < A.length) push(-1, A[i++]!);
  while (j < B.length) push(1, B[j++]!);
  return out;
}
