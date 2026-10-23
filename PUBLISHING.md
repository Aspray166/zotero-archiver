# 发布指南

## 0. 发布前：替换占位符

把下面 3 处 `USERNAME` 换成你的 GitHub 用户名，`Zotero Archiver` 换成你的署名：

1. `plugin/addon/manifest.json` → `author`、`homepage_url`、`update_url`。
2. `update.json` → `update_link` 里的 `USERNAME`。
3. `README.md` → 署名（如需）。

改完后重新打包：

```powershell
cd plugin
.\build-xpi.ps1
```

## 1. 发布到 GitHub

```powershell
cd zotero-archiver
git init
git add .
git commit -m "Zotero Archiver 1.0.0：归档所选论文 + 定期自动归档"
git branch -M main
git remote add origin https://github.com/<USERNAME>/zotero-archiver.git
git push -u origin main
```

然后在 GitHub 网页上：

1. 新建 **Release** → 标签填 `v1.0.0`，标题填 `1.0.0`。
2. 上传 `plugin/zotero-archiver.xpi` 作为附件（Releases 里直接放 xpi，方便下载）。
3. 发布。

> 注意：`.gitignore` 已忽略 `plugin/*.xpi`，所以 xpi 不会进仓库，只放 Release 附件。

## 2. 发布到 Zotero 插件库

1. 打开 https://www.zotero.org/support/plugins
2. 找到「提交插件」入口（Plugin Directory 的 submit 链接）。
3. 填写：
   - 插件名：`Zotero Archiver`
   - 插件 ID：`zotero-archiver@example.com`
   - 版本：`1.0.0`
   - 兼容版本：Zotero 7+（manifest 里是 `strict_min_version: 6.999`，`strict_max_version: 10.*`）
   - 简介：归档论文到独立归档库（完整保留标签/笔记/附件），支持定期自动归档。
   - 主页：你的 GitHub 仓库地址。
4. 上传 `plugin/zotero-archiver.xpi`。
5. 提交审核，等待 Zotero 官方审核通过后，插件会出现在插件库并可被用户安装。

## 3. 自动更新（可选）

`manifest.json` 的 `update_url` 指向仓库的 `update.json`。以后发新版时：

1. 改 `manifest.json` 的 `version`。
2. 在 `update.json` 的 `updates` 里加一条新版本记录（`update_link` 指向新 Release 的 xpi）。
3. 推送到 GitHub 并打新 Release。
