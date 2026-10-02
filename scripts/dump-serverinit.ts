// 转储 x11vnc ServerInit 原始字节（前 64 字节十六进制 + ASCII）
import net from "net"

const sock = net.connect(Number(process.argv[2] || 25900), "127.0.0.1")
let all = Buffer.alloc(0)
let phase = 0
let consumed = 0

sock.on("data", (chunk) => {
  all = Buffer.concat([all, chunk])
  if (phase === 0 && all.length >= 12) {
    console.log("版本:", all.slice(0, 12).toString().trim())
    all = all.slice(12)
    sock.write("RFB 003.008\n")
    phase = 1
  } else if (phase === 1 && all.length >= 2) {
    const n = all[0]
    console.log("安全类型数量:", n, "类型:", [...all.slice(1, 1 + n)])
    all = all.slice(1 + n)
    sock.write(Buffer.from([1]))
    phase = 2
  } else if (phase === 2 && all.length >= 4) {
    console.log("SecurityResult:", all.readUInt32BE(0))
    all = all.slice(4)
    sock.write(Buffer.from([1])) // ClientInit shared
    phase = 3
  } else if (phase === 3 && all.length >= 24) {
    // ServerInit 完整到达（含 name）
    console.log("\nServerInit 区域原始字节（从0开始）:")
    for (let off = 0; off < Math.min(48, all.length); off += 16) {
      const hex = all.slice(off, off + 16).toString("hex").match(/../g)?.join(" ") || ""
      const ascii = all.slice(off, off + 16).toString().replace(/[^\x20-\x7e]/g, ".")
      console.log(String(off).padStart(4) + ": " + hex.padEnd(48) + " |" + ascii + "|")
    }
    const w = all.readUInt16BE(0)
    const h = all.readUInt16BE(2)
    const nameLen16 = all.readUInt16BE(20) // RFC 6143：2 字节
    const nameLen32 = all.readUInt32BE(20) // 错误实现：4 字节
    console.log(`\n尺寸: ${w}x${h}`)
    console.log(`RFC 6143 语义 name-length(2字节@20): ${nameLen16}`)
    console.log(`4字节解读(错误): ${nameLen32}`)
    console.log(`按 RFC：name = [22, 22+${nameLen16}) = "${all.slice(22, 22 + nameLen16).toString().slice(0, 40)}"`)
    sock.end()
    setTimeout(() => process.exit(0), 300)
  }
})
sock.on("error", (e) => { console.error("错误:", e.message); process.exit(1) })
