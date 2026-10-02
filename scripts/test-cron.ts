import { parseCron, nextCronRun, describeCron } from "../src/lib/cron-next"
const cases = ["*/5 * * * *", "0 3 * * *", "* * * * *", "0 */1 * * *", "30 8 1 * *", "0 0 * * 0", "15,45 */2 * * 1-5", "bad expr", "60 * * * *", "*/5"]
for (const c of cases) {
  const p = parseCron(c)
  const n = p.ok ? nextCronRun(c) : null
  console.log(JSON.stringify(c), "→", p.ok ? "OK" : p.error, "| next:", n ? n.toISOString() : "null", "|", describeCron(c))
}
// 性能：最坏情况 5 年搜索无解（2月30日）
const t = Date.now()
nextCronRun("0 0 30 2 *")
console.log("worst-case (Feb 30) took", Date.now() - t, "ms")
