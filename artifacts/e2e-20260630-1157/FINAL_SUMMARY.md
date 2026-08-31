# 赛事通真机 E2E 测试摘要

时间：2026-06-30 11:57-12:15 CST

## 环境

- 项目：`/Users/caoxiaopeng/DevEcoStudioProjects/football`
- Bundle：`com.football.analytics.app`
- EntryAbility：`EntryAbility`
- 设备：`192.168.1.116:41885`
- 安装包：`entry/build/default/outputs/default/entry-default-release-device-e2e-20260630-signed.hap`
- 签名：release provision，`release-device.p7b`

## 构建与安装

- `hvigorw assembleHap --mode module -p product=default --no-daemon`：通过
- release-device 签名：通过
- 真机安装：通过

## 已覆盖用例

- 首屏赛事页：加载、底部赛事/分析/我的 Tab。
- 赛事搜索：打开搜索、输入无结果查询、清除搜索。
- 赛事卡片：点击进入赛事分析详情。
- 分析详情：详情打开、返回；详情内容滚动检查。
- 历史分析：进入分析 Tab、点击历史卡片打开详情、返回。
- 我的页：积分明细、分享获得积分记录、分享赛事通、用户协议、隐私政策、退出登录。
- 积分明细：滚动到底部点击“刷新记录”。
- 分享记录：点击“刷新记录”。
- 设置页：打开设置、比赛提醒开关、打开系统通知设置、缓存赛程和文章开关、清除离线缓存、返回。
- 登录页：用户协议、隐私政策、华为账号登录按钮触发。
- 首次法律弹窗：用户协议、隐私政策、不同意、同意并继续。
- 法律文档页：刷新、返回。

## 不可完全覆盖项

- `articles` 页面分支存在代码，但当前 UI 没有任何入口会设置 `tab = 'articles'`，所以不属于用户可达操作。
- `查看原文` 只在分析证据项带 URL 时出现；本次实际分析详情中滚动检查未出现该入口，因此无法点击。

## 日志结论

- 未发现 `JsError`。
- 未确认到本应用运行期崩溃。
- `hilog_filtered.log` 中的 `CRASH/FATAL/Exception` 字样主要来自系统相机、桌面、AppGallery、卸载重装窗口期的 bundle 查询，以及 WebView crashpad 符号文件告警，不是 `com.football.analytics.app` 的业务崩溃。

## 产物

- 主报告：`artifacts/e2e-20260630-1157/report.json`
- 过滤日志：`artifacts/e2e-20260630-1157/hilog_filtered.log`
- 截图与 layout：`artifacts/e2e-20260630-1157/device/`
