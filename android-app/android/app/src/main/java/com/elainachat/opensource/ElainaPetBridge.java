package com.elainachat.opensource;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 悬浮窗 WebView JS 桥：用户输入 / 主动回复 统一走网关 chat。
 */
public class ElainaPetBridge {
    public interface Callback { void onReply(String text, boolean error); }

    private final WebView webView;
    private volatile String baseUrl = "";
    private volatile String apiKey = "";
    private volatile String systemPrompt = "你是伊蕾娜（Elaina），一位微傲娇的天才魔女，喜欢旅行与读书。说话温柔但带一点小傲娇，用中文回复，简洁自然，偶尔有（动作/神态）描述。";

    private final Runnable onOpenApp;
    private final Runnable onStartDrag;
    private final Runnable onEndDrag;
    private final java.util.function.Consumer<Boolean> onInputFocus;
    private volatile String model = "mini-max-m3";

    public ElainaPetBridge(WebView webView, Runnable onOpenApp) {
        this(webView, onOpenApp, null, null, null);
    }

    public ElainaPetBridge(WebView webView, Runnable onOpenApp, Runnable onStartDrag, Runnable onEndDrag,
                           java.util.function.Consumer<Boolean> onInputFocus) {
        this.webView = webView;
        this.onOpenApp = onOpenApp;
        this.onStartDrag = onStartDrag;
        this.onEndDrag = onEndDrag;
        this.onInputFocus = onInputFocus;
    }

    /** 前端拖拽条：开始拖动悬浮窗 */
    @JavascriptInterface
    public void startDrag() {
        if (onStartDrag != null) onStartDrag.run();
    }

    /** 前端拖拽条：结束拖动 */
    @JavascriptInterface
    public void endDrag() {
        if (onEndDrag != null) onEndDrag.run();
    }

    /** 前端输入框获得/失去焦点：悬浮窗需要临时获取焦点才能弹出软键盘 */
    @JavascriptInterface
    public void setInputFocus(final boolean focused) {
        if (onInputFocus != null) onInputFocus.accept(focused);
    }

    /** 主 App 设置的模型（与主界面 state.settings.model 保持一致） */
    public void setModel(String m) {
        if (m != null && !m.trim().isEmpty()) model = m.trim();
    }

    /** 供悬浮窗前端读取网关配置（语音输入等） */
    @JavascriptInterface
    public String getConfig() {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("baseUrl", baseUrl);
            o.put("apiKey", apiKey);
            o.put("model", model);
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    /** 返回主界面（安卓悬浮窗）：拉起 ElainaChat App */
    @JavascriptInterface
    public void openApp() {
        if (onOpenApp != null) onOpenApp.run();
    }

    public void setConfig(String baseUrl, String apiKey, String systemPrompt) {
        this.baseUrl = baseUrl == null ? "" : baseUrl.trim().replaceAll("/+$", "");   /* 与主前端一致：去掉尾部斜杠，避免 host//api 404 */
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        if (systemPrompt != null && systemPrompt.trim().length() > 0) this.systemPrompt = systemPrompt.trim();
    }

    public String getBaseUrl() { return baseUrl; }
    public String getApiKey() { return apiKey; }

    /** 用户输入（悬浮窗内） */
    @JavascriptInterface
    public void sendMessage(final String text) {
        if (text == null || text.trim().isEmpty()) return;
        chat("", text);
    }

    /** 主动回复入口：context 为当前界面文本，来自无障碍服务 */
    public void proactiveChat(String context) {
        String prompt = "（主动搭话）现在用户正处在这个场景：" + cut(context, 800)
                + "。自然地跟用户闲聊一句，不要复述界面内容，控制在60字以内，语气照常（可带动作描述）。";
        chat(context, prompt);
    }

    private void chat(final String context, final String userText) {
        new Thread(() -> {
            try {
                if (baseUrl.isEmpty()) { postToWeb("系统未配置网关地址，请先在 App 设置里填写"); return; }
                JSONArray msgs = new JSONArray();
                JSONObject sys = new JSONObject();
                sys.put("role", "system");
                sys.put("content", systemPrompt);
                msgs.put(sys);
                if (context != null && !context.isEmpty()) {
                    JSONObject ctx = new JSONObject();
                    ctx.put("role", "user");
                    ctx.put("content", "（当前屏幕内容摘要，供参考：" + cut(context, 1200) + "）");
                    msgs.put(ctx);
                }
                JSONObject usr = new JSONObject();
                usr.put("role", "user");
                usr.put("content", userText);
                msgs.put(usr);
                JSONObject body = new JSONObject();
                body.put("model", "mini-max-m3");
                body.put("messages", msgs);

                HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + "/api/chat/completions").openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(120000);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                if (!apiKey.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + apiKey);
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = conn.getResponseCode();
                String raw = readStream(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
                if (code >= 400) { postToWeb("网关返回 [" + code + "]，请检查 Key / 地址"); return; }
                JSONObject root = new JSONObject(raw);
                String content = root.optJSONArray("choices").optJSONObject(0).optJSONObject("message").optString("content", "");
                postToWeb(content.isEmpty() ? "（伊蕾娜没有说话）" : content);
            } catch (Exception e) {
                postToWeb("连接失败：" + (e.getMessage() == null ? "网络错误" : e.getMessage()));
            }
        }).start();
    }

    private String cut(String s, int max) { return s == null || s.length() <= max ? s : s.substring(0, max); }

    private String readStream(java.io.InputStream is) throws Exception {
        if (is == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    private void postToWeb(final String text) {
        new Handler(Looper.getMainLooper()).post(() -> {
            webView.evaluateJavascript("window.PetOnReply && window.PetOnReply(" + JSONObject.quote(text) + ")", null);
        });
    }
}
