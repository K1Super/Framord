# Framord

<img src="assets/framord.png" width="88" alt="Framord">

Windows 桌面端批量照片命名工具，基于 Electron 构建。全部处理在本机完成，不上传任何照片或信息

## 功能

- 模板命名：`{word}` 随机单词、`{rand}` 6 位随机码、`{date}` / `{time}` 拍摄时间、`{seq}` 序号、`{name}` 原文件名、`{folder}` 文件夹、`{year}` / `{month}` / `{day}`，支持起始序号与补零位数
- 查找替换：支持正则表达式与区分大小写，替换后实时预览
- 批量扫描：可包含子目录，按 JPEG / PNG / HEIC · AVIF / TIFF / RAW 过滤，支持按文件名、拍摄时间、修改时间、文件大小升降序排列
- 拍摄时间：读取 EXIF 拍摄时间，缺失时回退到文件修改时间
- 命名预览：执行前逐项展示原名与新名，自动检测同目录冲突，随机码保证批内唯一
- 历史与撤销：每批重命名写入历史，可一键撤销
- 中断恢复：重命名过程中的待办日志在异常退出后可恢复，避免文件处于中间状态

## 快速开始

环境要求：Windows 10 / 11，Node.js 18 及以上

```bash
npm install
npm start
```

仓库内 `.npmrc` 已配置 npmmirror 镜像，便于安装 Electron

## 测试

```bash
npm test        # 命名规划、EXIF、重命名、随机码、扫描单元测试
npm run smoke   # Electron 冒烟运行
```

## 目录结构

```
electron/          主进程与引擎
  main.js          窗口、IPC、生命周期
  preload.js       受限上下文桥接
  engine/          扫描、EXIF、规划、重命名
renderer/          界面（原生 HTML / CSS / JS）
shared/planner.js  命名规则规划器（主进程与测试共用）
test/              node:test 单元测试
assets/            应用图标
```

## 数据与隐私

- 照片仅在本机读取与改名，无网络请求
- 历史记录保存在 Electron 用户数据目录下的 `rename-history.json`
- 渲染进程启用 `contextIsolation`、`sandbox`，并配置 CSP，禁用外部导航与新窗口

## 许可

[MIT](LICENSE)
