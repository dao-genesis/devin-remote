# devin-git-auth · 多账号绑定同一 GitHub

> 让多个 Devin 账号共享/绑定同一 GitHub 身份，基于 `git-permissions` 做真实授权管理（而非伪装）。

- **扩展 id**：`devaid.devin-git-auth`
- **类型**：辅助 · 独立插件（按需安装）

## 构建

```bash
node tools/pack-vsix.js addons/devin-git-auth     # 纯 JS，免转译
```

## 安装

```bash
devin-desktop --install-extension devin-git-auth-<ver>.vsix --force   # 或 code --install-extension ...
```

下载见仓库 [Releases](https://github.com/zhouyoukang1234-spec/devin-remote/releases)（tag 形如 `devin-git-auth-v<版本>`）。

> 去中心化：本模块独立发版，开发它才会刷新 `devin-git-auth-v*` Release，与其它插件互不干扰。
