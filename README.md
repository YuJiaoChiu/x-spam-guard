# X Spam Guard

Chrome MV3 插件 + Node/Express 后端，用于识别 X/Twitter 中文区垃圾评论账号，支持公共黑名单同步、用户共享样本、管理员审核和 GitHub Pages 公开页。

目标流程：

`安装插件 -> 用户同意 -> 勾选同步/共享 -> 开始 -> 本地初筛 -> 后端规则+AI复核 -> 随机节奏拉黑`

## 目录

- `extension/`：Chrome 插件，负责扫描 X 页面、本地规则初筛、同步黑名单和执行拉黑。
- `server/`：后端 API、管理后台、AI 配置、黑名单和贡献审核。
- `docs/`：GitHub Pages 公开页，展示公开黑名单、样本分析和 spam 上报入口。
- `scripts/update-public-data.js`：从后端拉取公开数据，更新 `docs/data/public-export.json`。
- `.github/workflows/update-public-data.yml`：GitHub Actions 定时更新公开数据。

## 本地启动后端

```powershell
npm --prefix .\server install
npm --prefix .\server run dev
```

默认地址：

- 健康检查：`http://127.0.0.1:8787/health`
- 管理后台：`http://127.0.0.1:8787/admin`

## 加载插件

1. 打开 `chrome://extensions`
2. 打开“开发者模式”
3. 点“加载已解压的扩展程序”
4. 选择 `D:\tx\srt\售卖\bas\extension`
5. 打开 X 页面后点插件“开始”

插件默认内置云端后端地址和 Client Token。普通用户不需要手动填写后端地址。

## 判定链路

1. 用户端只上传本地规则命中的候选，不上传所有评论。
2. 后端执行强规则 + AI 二次判定。
3. 只有 `shouldBlock=true` 才进入用户本地黑名单和随机拉黑队列。
4. 如果用户开启“共享命中样本”，命中样本会上报到 `/api/contributions`。
5. 后端自动复审高置信贡献；不确定的留给管理员审核。
6. 管理员审核通过后写入 `confirmed` 公共黑名单。
7. 用户插件定时同步 `confirmed` 黑名单。

## 管理后台

后台可以查看：

- 黑名单分层：`confirmed/suspected/reported/whitelist`
- 每个账号命中的字段、规则、AI 原因
- 用户贡献和公开上报样本
- 拉黑任务状态：`pending/running/success/failed/cooldown/skipped`
- AI 配置和测试判定

## GitHub Pages 公开页

`docs/` 可以作为 GitHub Pages 根目录，展示：

- 已审核通过的公开黑名单
- 高频规则、命中字段、样本 pattern 分析
- 用户 spam 样本提交表单

开启方式：

1. GitHub 仓库进入 `Settings -> Pages`
2. Source 选择 `Deploy from a branch`
3. Branch 选择 `main`
4. Folder 选择 `/docs`

## 定时更新公开数据

GitHub Actions 每小时执行一次：

```powershell
npm run public:update
```

它会从：

`http://124.221.11.190/x-spam-guard/api/public/export`

拉取公开数据并写入：

`docs/data/public-export.json`

如果后端换域名，在 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Variables` 配置：

`PUBLIC_EXPORT_URL=https://your-domain.example/x-spam-guard/api/public/export`

## 公开上报接口

公开页表单提交到：

`/api/public/reports`

当前 `docs/config.js` 已把 `reportEndpoint` 留空，所以 GitHub Pages 只展示公开黑名单和样本分析，暂不开放在线提交。

注意：GitHub Pages 是 HTTPS。如果后端仍是 `http://124.221.11.190`，浏览器会拦截表单提交。正式上线需要给 VPS 绑定域名并配置 HTTPS，然后修改 `docs/config.js` 里的 `reportEndpoint`。

公开上报只进入待审队列，不会自动加入黑名单。管理员在后台点击“通过”后才会进入 `confirmed`。
