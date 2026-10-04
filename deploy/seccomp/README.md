# Docker 自定义 seccomp profile —— 启用 Chromium 原生沙箱

## 用途

Dockyard 浏览器容器默认以最强隔离运行（CapDrop=ALL + no-new-privileges + 只读根文件系统）。
该组合下 Chromium 的原生进程级沙箱（userns sandbox）无法创建用户命名空间 —— Docker
默认 seccomp 配置会拦截非特权的 `clone(CLONE_NEWUSER)`，于是镜像内 supervisor 会回退
`--no-sandbox`（浏览器顶部出现 "You are using an unsupported command-line flag:
--no-sandbox" 提示条，平台已通过 `--test-type` 抑制该提示条，容器级隔离依然完整）。

部署本 profile 后，Chromium 原生沙箱可用（渲染进程零 syscall：网页恶意代码无法读写任何
本地文件），supervisor 探测直接通过，永不回退 `--no-sandbox`。

## 安全模型说明

- 本 profile 的 `defaultAction=ALLOW` 是有意设计：Chromium 的 userns sandbox 需要完整的
  `clone`/`unshare`/`mount`/`prctl` 能力在【其私有命名空间内】建立沙箱。
- 宿主机/其他容器的安全不依赖本 profile，而依赖容器本身的三重约束（这些保持不变）：
  1. `CapDrop=ALL` —— 内核 capability 门控的 syscall（mount/setns/kexec/module/...）
     在初始命名空间全部 EPERM；
  2. `no-new-privileges` —— setuid 提权路径封死；
  3. 只读根 FS + noexec 数据卷 + 独立会话网络（ICC 关闭）。
- 用户命名空间内的 CAP_SYS_ADMIN 只作用于该进程【私有】的挂载/PID 视图 —— 与桌面
  Linux 允许普通应用使用 unprivileged userns 的安全模型一致（Ubuntu 24.04 默认）。
- profile 仍显式拦截与容器业务无关的高危 syscall（内核模块/eBPF/性能事件/keyring/
  userfaultfd/内核转储等），收紧无 capability 门控的旁路面。

## 部署步骤

1. 把本文件复制到 **Docker daemon 所在主机**（不是平台容器内）：

   ```sh
   scp deploy/seccomp/dockyard-chromium.json root@<docker-host>:/etc/docker/seccomp/
   ```

2. 管理后台 → 系统配置 → Docker → 「浏览器容器附加 --security-opt」填：

   ```json
   ["seccomp=/etc/docker/seccomp/dockyard-chromium.json"]
   ```

   保存后创建的新沙箱即生效（存量沙箱重建后生效）。

3. 验证：沙箱容器日志（docker logs）应出现
   `Chromium 原生沙箱探测通过（渲染进程零 syscall）`，且浏览器顶部不再出现
   `--no-sandbox` 提示条。

## 回退

清空后台「浏览器容器附加 --security-opt」配置即可回到默认（CapDrop=ALL 的
Docker 默认 seccomp 行为）。
