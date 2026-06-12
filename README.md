# Residential Proxy Kit (Claude/GPT/Gemini/Antigravity)

一套可复用的 macOS 方案：

- Claude（网页/桌面/CLI）
- GPT（ChatGPT）
- Gemini（网页/API）
- Gemini 编程版（Antigravity）

统一走家宽 SOCKS5 出口；其他流量继续走 Clash 默认线路。

## 1. 快速开始（新电脑一条命令安装）

### 1.1 克隆仓库

```bash
git clone https://github.com/allentofight/residential-proxy-kit.git
cd residential-proxy-kit
```

### 1.2 一键安装

```bash
bash ./scripts/install-on-mac.sh \
  --res-host <your_residential_host> \
  --res-port <your_residential_port> \
  --res-user <your_residential_username> \
  --res-pass <your_residential_password> \
  --expected-ip <your_expected_residential_ip> \
  --wifi-service "Wi-Fi" \
  --clash-port 7897
```

说明：

- `--expected-ip` 用于严格验收，建议填写。
- `--clash-port` 是 Clash mixed-port，默认 `7897`。

配置说明，首先访问：[https://www.lycheeip.com/ip/static/order](https://www.lycheeip.com/ip/static/order)

点击详情出现弹框

![info](https://pic1.imgdb.cn/item/6a2c1c09ad4b105876848a5a.png)

则相应的 bash 命令应该为:

```
bash ./scripts/install-on-mac.sh \
  --res-host 38.13.22.49 \
  --res-port 27114 \
  --res-user 08c1b1dc \
  --res-pass 35bfdsfd41a11 \
  --expected-ip 38.13.22.49 \
  --wifi-service "Wi-Fi" \
  --clash-port 7897
```



## 2. 登录前验收（强烈建议）

### 2.1 打开检测页面

[http://127.0.0.1:18100](http://127.0.0.1:18100)

页面提示“✅ 检测通过：可以登录”后再登录账号。

### 2.2 命令行验收

```bash
~/.claude/residential-proxy/preflight.sh <your_expected_residential_ip>
```

## 3. 路由策略

- 这些域名走家宽：Claude/OpenAI/Gemini/Antigravity 关键域名（含 `daily-cloudcode-pa.googleapis.com`）。
- 其余域名走 Clash 默认线路。

## 4. 安全建议

- 切线路前先退出所有客户端。
- 通过检测后再登录。
- 不要把你的代理账号密码提交到 Git。

## 5. 目录结构

```text
scripts/
  proxy-router.js
  preflight.sh
  healthcheck-server.js
  install-on-mac.sh
ui/
  healthcheck.html
```

