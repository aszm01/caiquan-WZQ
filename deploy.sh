#!/usr/bin/env bash
# ============================================================
# 猜拳五子棋 - 云服务器一键部署脚本（适用于 CentOS / Ubuntu / Debian）
#
# 用法：
#   1. 把 wzq.html、server.js、package.json、deploy.sh 放到服务器同一目录
#   2. 执行： bash deploy.sh
#   3. 到云控制台「安全组」放行 8080 端口（TCP）
#   4. 访问 http://服务器公网IP:8080 即可开玩
# ============================================================
set -e

echo "==> 1/4 检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 18 或 20 LTS。"
  echo "Ubuntu/Debian 参考："
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi
echo "Node 版本：$(node -v)"
echo "npm  版本：$(npm -v)"

echo "==> 2/4 安装依赖"
npm install --omit=dev

echo "==> 3/4 安装 pm2 并启动服务"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi
pm2 start server.js --name wzq
pm2 save

echo "==> 4/4 配置开机自启"
pm2 startup

echo ""
echo "=============================================="
echo " 部署完成！"
echo " 访问地址：http://<本服务器公网IP>:8080"
echo " 常用命令：pm2 logs wzq  查看日志"
echo "           pm2 restart wzq  重启服务"
echo " 若打不开：确认云控制台安全组已放行 8080 端口"
echo "=============================================="
