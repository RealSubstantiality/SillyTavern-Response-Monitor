# Response Monitor — SillyTavern 扩展
SillyTavern自带回复成功后播放提示音功能，但是生成失败后没有提示。

本扩展可以在生成失败/空回复时播放自定义提示音（成功时不响）。

## 安装
SillyTavern → Extensions → Manage → Install from Git  
粘贴：
[https://github.com/RealSubstantiality/SillyTavern-Response-Monitor](https://github.com/RealSubstantiality/SillyTavern-Response-Monitor)

安装后在扩展列表里启用；首次任意点击页面以解锁浏览器音频。

## 2026.2.26更新说明
增加对于空回的响应，增加回复成功的提示音。

## 2025.12.9更新说明
可以调用Windows/iOS端的系统通知，在iOS设备替代振动提示。

iOS设备需将SillyTavern作为PWA应用安装，即在Safari中访问SillyTavern，并“添加到主屏幕”。

若成功作为PWA安装，可以注意到此时打开SillyTavern没有Safari的地址栏。

## 2025.12.1更新说明
在扩展管理页中增加设置面板。

增加Android设备的振动提示功能。

## 自定义声音
将 `fail.mp3` 或 `success.mp3` 替换为你自己的音效文件（同名覆盖）。

## 2026.10.10 更新说明（v1.3.4）
修复 HTTP/流式响应包含文本但 SillyTavern 最终聊天消息为空时的误报成功：在网络解析之外，核对生成结束后的实际消息，并对 Swipe、续写和手动停止分别处理。

扩展标题直接显示 v1.3.4；“记录判定日志”已移到顶部触发条件区域，开启后在浏览器 F12 控制台查看原因（不会记录聊天正文）。

## 2026.10.9 更新说明（v1.3.3）
修复流式空回复偶发被判成功的问题：等待完整 SSE/JSON 响应，再识别有效正文；忽略心跳、结束标记、统计、角色和推理信息，同时隔离不同请求的检测状态。

扩展设置的“功能测试”可开启“输出诊断日志（不记录回复内容）”，浏览器控制台会记录状态码、判定结果和原因，不记录聊天正文。

## 更新
从 Git 重新安装或在扩展管理里点击 Update。

## License
MIT