#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077

exec 9>.deploy.lock
flock 9

sudo_cmd=()
if (( EUID != 0 )); then sudo_cmd=(sudo); fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 ||
   ! command -v openssl >/dev/null || ! command -v curl >/dev/null; then
  . /etc/os-release
  if [[ "${ID:-}" != ubuntu ]]; then
    echo '自动安装依赖需要 Ubuntu。也可预装 Docker Engine、Compose v2、curl 和 openssl。' >&2
    exit 1
  fi
  "${sudo_cmd[@]}" apt-get update
  "${sudo_cmd[@]}" apt-get install -y ca-certificates curl openssl
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    "${sudo_cmd[@]}" install -m 0755 -d /etc/apt/keyrings
    "${sudo_cmd[@]}" curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    "${sudo_cmd[@]}" chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$(dpkg --print-architecture)" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" |
      "${sudo_cmd[@]}" tee /etc/apt/sources.list.d/docker.list >/dev/null
    "${sudo_cmd[@]}" apt-get update
    "${sudo_cmd[@]}" apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
fi

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then
  "${sudo_cmd[@]}" systemctl enable --now docker
  if ! docker info >/dev/null 2>&1; then docker_cmd=("${sudo_cmd[@]}" docker); fi
fi

if [[ ! -e .env ]]; then
  tmp_env=$(mktemp .env.XXXXXXXX)
  trap 'rm -f -- "$tmp_env"' EXIT
  secret=$(openssl rand -hex 32)
  sed "s/^SESSION_SECRET=$/SESSION_SECRET=$secret/" .env.example > "$tmp_env"
  mv -- "$tmp_env" .env
  unset secret
  trap - EXIT
fi
chmod 600 .env
# nginx 工作者需读取 Webroot 中的 ACME 验证文件。
mkdir -p -m 0755 deploy/acme

compose=("${docker_cmd[@]}" compose)
"${compose[@]}" config --quiet
"${compose[@]}" up --build -d --wait --wait-timeout 120
binding=$("${compose[@]}" port nginx 80)
# 旧版 curl（如 EL8 自带 7.61）不认识 --retry-all-errors，先探测能力再拼接参数，
# 否则健康检查会因参数不被识别而误报失败（其实站点已经起来了）。
retry_args=(--retry 8 --retry-delay 2 --retry-connrefused)
if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
  retry_args+=(--retry-all-errors)
fi
curl -fsS "${retry_args[@]}" "http://127.0.0.1:${binding##*:}/health"
printf '\n'
