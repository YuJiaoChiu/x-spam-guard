# X Spam Guard Public Pages

这个目录用于 GitHub Pages。

- `index.html`：公开黑名单、样本分析、spam 上报表单。
- `data/public-export.json`：公开数据快照，由 GitHub Actions 定时更新。
- `config.js`：页面配置。当前 `reportEndpoint` 留空，公开页暂不开放在线提交。正式公开提交需要把它改成 HTTPS 后端地址。

## GitHub Pages 设置

1. Repository Settings -> Pages。
2. Source 选择 `Deploy from a branch`。
3. Branch 选择 `main`，目录选择 `/docs`。

## 定时更新

`.github/workflows/update-public-data.yml` 每小时运行一次，从 `PUBLIC_EXPORT_URL` 拉取公开数据并提交到 `docs/data/public-export.json`。

如果后端换域名，在仓库 `Settings -> Secrets and variables -> Actions -> Variables` 添加：

`PUBLIC_EXPORT_URL=https://your-domain.example/x-spam-guard/api/public/export`
