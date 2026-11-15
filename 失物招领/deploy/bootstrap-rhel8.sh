#!/usr/bin/env bash
# 为 Alibaba Cloud Linux 3 / RHEL 8 系主机准备 deploy.sh 所需依赖。
#
# 用法（root）：bash deploy/bootstrap-rhel8.sh
# 职责边界：只做宿主机准备，不改应用代码、不生成 .env、不启动容器。
# 完成后仍需 git clone 仓库，并在 失物招领 目录执行 bash deploy/deploy.sh。
set -euo pipefail

if (( EUID != 0 )); then
  echo '请用 root 运行：sudo bash deploy/bootstrap-rhel8.sh' >&2
  exit 1
fi

. /etc/os-release
case "${PLATFORM_ID:-}" in
  platform:el8|platform:al8) ;;
  *)
    echo "本脚本只适用于 EL8/AL8 系（当前 ${PLATFORM_ID:-未知}）；Ubuntu 直接运行 deploy/deploy.sh。" >&2
    exit 1
    ;;
esac

for pkg in git curl openssl; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    dnf -y install "$pkg"
  fi
done

# 必须用 EL8 构建：download.docker.com/linux/centos/9 是 EL9 包，
# 依赖 GLIBC_2.34，在 EL8 主机上 dnf 会报 "cannot install the best candidate"。
# $basearch 由 dnf 展开，不在脚本里写死架构。
cat > /etc/yum.repos.d/docker-ce.repo <<'REPO'
[docker-ce-stable]
name=Docker CE Stable (EL8 mirror)
baseurl=https://mirrors.aliyun.com/docker-ce/linux/centos/8/$basearch/stable
enabled=1
gpgcheck=1
gpgkey=https://download.docker.com/linux/centos/gpg
REPO

dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 中国内地节点常无法直连 auth.docker.io / registry-1.docker.io，
# 不配置加速会导致 compose up --build 拉不到 node:22-bookworm-slim 与 nginx:stable-alpine。
# 已有 daemon.json 时不覆盖，避免破坏运维自己追加的配置。
install -d -m 0755 /etc/docker
if [[ ! -e /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run"]
}
JSON
else
  echo '检测到已有 /etc/docker/daemon.json，未覆盖；请自行确认已配置可用的 registry-mirrors。' >&2
fi

systemctl enable --now docker
docker info >/dev/null

echo "Docker $(docker --version)、Compose $(docker compose version --short) 已就绪。"
echo '下一步：clone 仓库后，在 失物招领 目录运行 bash deploy/deploy.sh。'
