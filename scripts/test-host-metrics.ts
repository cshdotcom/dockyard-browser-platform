import { hostRealMetrics } from "../src/lib/external/docker"
import { ENV } from "../src/lib/env"
async function main() {
  const m = await hostRealMetrics({ storageFallbackPath: ENV.storageLocalPath })
  console.log(JSON.stringify(m, null, 2))
}
main()
