# ElainaPet（PC 客户端）

与安卓同源的 ElainaChat 桌面端：完整聊天主界面（WPF + WebView2 加载 web-pack）+ 桌宠模式（伊蕾娜立绘 + 玻璃气泡）。

## 构建
1. 打包 Web 界面（与安卓同源，相对路径化）：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pack-web.ps1
2. 构建：dotnet build -c Release
3. 发布单文件 exe（免装 .NET）：
   dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
   产物：bin/Release/net10.0-windows/win-x64/publish/ElainaPet.exe

## 结构
- MainWindow.xaml(.cs)：主窗体（聊天界面 + 桌宠模式切换，由设置「桌宠」开关驱动）
- SettingsWindow / PetBrain.cs：设置持久化 + 网关 LLM 调用 + 主动回复定时（UIA 读前台窗口）
- UiTextReader.cs：Windows UIAutomation 前台窗口文本读取
- web-pack（生成物，不入库）：scripts/pack-web.ps1 生成
- www/：桌宠悬浮窗页面（伊蕾娜立绘 + 玻璃气泡 + 表情系统）
