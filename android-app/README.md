# ElainaChat Open Android

这是开源 BYOK Android 客户端，包名 `com.elainachat.opensource`，应用名 `ElainaChat Open`。它不依赖作者网关：Web UI 通过 `ByokHttpPlugin` 直连用户选择的 HTTPS 服务，通过 `ByokSecretsPlugin` 使用 Android Keystore 加密 API Key。

先在上级目录运行 `npm run sync:web`，再运行 `npm install`、`npm test` 和 `npm run build:debug`。

## 首次准备

```powershell
cd E:\ElainaChat\open-source
npm run sync:web
cd android-app
npm install
npm test
```

`android/` 原生工程已经包含在本目录中，不要再次执行 `npx cap add android`。

构建还需要本机安装 Android Studio、Android SDK 和 JDK 21，并设置 Android SDK。准备完成后（将路径替换成你的实际安装位置）：

```powershell
$env:JAVA_HOME='C:\path\to\jdk-21'
$env:ANDROID_HOME='E:\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
npm run build:debug
```

Debug APK 输出位置：

`android/app/build/outputs/apk/debug/app-debug.apk`

## 使用方式

1. 打开 APK 的设置页。
2. 填写自己的 DeepSeek Key；如需语音，再填写自己的 MiniMax Key 与音色 ID。
3. 默认直连 DeepSeek 官方 API，也可以填写用户自己的 OpenAI 兼容 HTTPS 地址。
4. 如需 Android 语音输入，可选择阿里百炼并填写自己的 DashScope Key。

正式发布前还需要配置自己的 release 签名 keystore 与隐私说明。仓库生成的 debug APK 只用于测试安装。
