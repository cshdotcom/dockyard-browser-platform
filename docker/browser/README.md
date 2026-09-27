# Dockyard Hardened Browser Image

平台自托管的硬隔离浏览器运行时镜像（`docker/browser/Dockerfile`），由平台经 Docker API 直接编排，与 `src/lib/external/docker.ts` 的 `buildBrowserHostConfig` 配合生效。

## 隔离与防退出保证

| 保证 | 实现层 | 说明 |
|---|---|---|
| 无法退出浏览器 | supervisor.sh 死循环 | 用户关闭窗口 / Ctrl+Q / 崩溃闪退 / OOM → **1 秒内以同一 Profile 自动拉起** |
| 容器级自愈 | Docker `RestartPolicy=always` | 容器被杀后 Docker 自动重启，Profile 卷持久 |
| 平台级自愈 | 任务引擎 `novnc_health` 看门狗 | 会话崩溃自动重建（连续 3 轮失败才转 ERROR） |
| 其他用户资料不可读 | 唯一挂载本人 Profile 卷 | 其他用户的文件**不在容器 mount namespace 中**（不可见 = 不可读） |
| 系统文件不可写 | `ReadOnlyRootfs: true` | 根文件系统只读，仅白名单 tmpfs 可写 |
| 无法提权 | `CapDrop=ALL` + `no-new-privileges` | 丢弃全部 capabilities，禁 setuid 提权 |
| 下载软件无法运行 | 下载目录 / tmpfs 全部 `noexec` | 下载可执行文件 → 运行即 `Permission denied` |
| 资源硬限制 | Memory/NanoCpus/PidsLimit + 禁 swap | 超限 OOM 硬终止 |
| 网络隔离 | `dockyard-sessions` 专用桥网络 | 容器互不可见；仅平台与 VNC 桥可访问 5900/9222 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RESOLUTION` | `1280x800` | 虚拟显示分辨率 |
| `START_URL` | `about:blank` | 启动页（按模板/用户配置下发） |
| `PROXY_URL` | 空 | 代理服务器（`socks5://…` / `http://…`） |

## 构建

```bash
docker build -t ghcr.io/cshdotcom/dockyard-browser:latest docker/browser
```

CI（`.github/workflows/docker-browser.yml`）在 push 到 main 时自动构建并推送多架构镜像至 GHCR。

## 端口（仅隔离网络内）

- `5900` — RFB (VNC)，由平台 vnc-bridge 中转，浏览器客户端凭 HMAC 单次票据接入
- `9222` — CDP 调试端口，由平台统一网关中转
