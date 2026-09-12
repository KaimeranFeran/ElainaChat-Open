package com.elainachat.opensource;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * 桌宠守护服务：
 * - 前台服务（specialUse）常驻通知 = 保活兜底
 * - 悬浮窗 WebView（加载 public/pet.html，玻璃气泡 + 魔女形象 + 输入框）
 * - 定时主动回复：间隔可配（5~60 分钟），读无障碍前台文本后调网关
 */
public class ElainaPetService extends Service {

    private static final String CHANNEL_ID = "elaina_pet_channel";
    private static final int NOTIF_ID = 4701;
    private static ElainaPetService instance = null;

    private WindowManager windowManager;
    private WebView petView;
    private ElainaPetBridge bridge;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long intervalMillis = 15 * 60 * 1000L;
    private boolean proactive = false;
    private long lastProactiveAt = 0;

    public static ElainaPetService getInstance() { return instance; }

    @Override
    public void onCreate() {
        super.onCreate();
        /* OCR 二轮 N3：未开启桌宠时不建前台通知（无障碍重连会无条件拉起本服务） */
        try {
            if (!getSharedPreferences("elaina_pet", MODE_PRIVATE).getBoolean("enabled", false)) {
                stopSelf();
                return;
            }
        } catch (Throwable ignored) { }
        instance = this;
        startForegroundCompat();
    }

    public static final String ACTION_STOP = "com.elainachat.opensource.STOP_PET";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            try { getSharedPreferences("elaina_pet", MODE_PRIVATE).edit().putBoolean("enabled", false).apply(); } catch (Throwable ignored) { }
            stopSelf();
            return START_NOT_STICKY;
        }
        SharedPreferences sp = getSharedPreferences("elaina_pet", MODE_PRIVATE);
        boolean enabled = sp.getBoolean("enabled", false);
        if (!enabled) {
            stopSelf();
            return START_NOT_STICKY;
        }
        proactive = sp.getBoolean("proactive", false);
        int interval = sp.getInt("interval", 15);
        interval = Math.max(5, Math.min(60, interval));
        intervalMillis = interval * 60 * 1000L;
        String base = sp.getString("baseUrl", "");
        String key = sp.getString("apiKey", "");
        String prompt = sp.getString("systemPrompt", "");
        ensureOverlay();
        if (bridge != null) bridge.setConfig(base, key, prompt);
        scheduleLoop();
        return START_STICKY;
    }

    /* ---------- 前台通知（保活） ---------- */
    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Elaina 桌宠", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        Intent app = new Intent(this, MainActivity.class);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, app, piFlags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle("Elaina 桌宠运行中")
                .setContentText("伊蕾娜在桌面上陪着你")
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .setContentIntent(pi);
        /* OCR A3：通知栏提供「停止桌宠」操作（Android 13+ 无需进设置） */
        try {
            Intent stopIntent = new Intent(this, ElainaPetService.class).setAction(ACTION_STOP);
            PendingIntent stopPi = PendingIntent.getService(this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止桌宠", stopPi);
        } catch (Throwable ignored) { }
        Notification notif = builder.build();
        int type = 0;
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, notif, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIF_ID, notif);
    }

    /* ---------- 悬浮窗 ---------- */
    private void ensureOverlay() {
        if (petView != null) return;
        try {
            windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            SharedPreferences sp = getSharedPreferences("elaina_pet", MODE_PRIVATE);
            float petScale = 1f;
            try { petScale = Math.max(0.6f, Math.min(1.6f, Float.parseFloat(sp.getString("scale", "1")))); } catch (Exception e) { petScale = 1f; }
            boolean clickthrough = sp.getBoolean("clickthrough", false);
            int petFlags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
            /* 桌宠包含输入框，不能把整个 Overlay 设为 NOT_TOUCHABLE；否则触摸会穿透到后面的应用，输入框永远无法获得焦点。 */
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    dp((int) (300 * petScale)), dp((int) (470 * petScale)),
                    (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                            : WindowManager.LayoutParams.TYPE_PHONE),
                    petFlags,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.RIGHT;
            /* OCR POS：恢复上次拖动后的位置（没有则默认右上角+状态栏下方） */
            lp.x = sp.getInt("posX", dp(8));
            lp.y = sp.getInt("posY", dp(12) + statusBarHeight());
            draggable = sp.getBoolean("draggable", true);

            petParams = lp;   /* 提升为字段：输入焦点切换时需要动态改 flags */
            petView = new WebView(this);
            WebSettings ws = petView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setAllowFileAccess(true);
            ws.setAllowFileAccessFromFileURLs(true);
            /* 安全：只允许本地 asset 页面（配合 WebViewClient 导航白名单），不开放通用跨域文件访问 */
            ws.setAllowUniversalAccessFromFileURLs(false);
            ws.setCacheMode(WebSettings.LOAD_DEFAULT);
            petView.setBackgroundColor(Color.TRANSPARENT);
            petView.setOverScrollMode(View.OVER_SCROLL_NEVER);

            /* 安全：导航白名单 —— file:///android_asset/... 的 authority 为空，android_asset 在 path 上（OCR 二轮 1） */
            petView.setWebViewClient(new android.webkit.WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    if (bridge != null) bridge.markPageReady();
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                    android.net.Uri u = request.getUrl();
                    String scheme = u == null ? "" : u.getScheme();
                    String path = u == null ? "" : u.getPath();
                    boolean local = "file".equals(scheme) && path != null && path.startsWith("/android_asset/");
                    if (local) return false;
                    if (!request.isForMainFrame()) return true;            /* 子框架一律不外跳，避免钓鱼 */
                    if ("http".equals(scheme) || "https".equals(scheme)) {
                        try {
                            Intent i = new Intent(Intent.ACTION_VIEW, u);
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(i);
                        } catch (Exception ignored) { }
                    }
                    return true;
                }
            });
            petView.setWebChromeClient(new android.webkit.WebChromeClient() {
                @Override
                public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                    /* 安全：只对本地 asset 页面授予录音；且必须已获得系统 RECORD_AUDIO 权限 */
                    /* OCR 二轮 2：file:// 页面的 origin 是 "file://"（host 为空），不能用 host 判 asset */
                    boolean localOrigin = false;
                    try {
                        android.net.Uri o = request.getOrigin();
                        localOrigin = o != null && "file".equals(o.getScheme());
                    } catch (Throwable ignored) { }
                    boolean micGranted = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED;
                    for (String res : request.getResources()) {
                        if (android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                            if (localOrigin && micGranted) request.grant(new String[]{ res });
                            else {
                                request.deny();
                                if (petView != null) petView.post(() -> {
                                    try {
                                        petView.evaluateJavascript("window.PetShowTip && window.PetShowTip('麦克风不可用：请先回主界面用一次语音输入完成授权')", null);
                                    } catch (Throwable ignored) { }
                                });
                            }
                            return;
                        }
                    }
                    request.deny();
                }
            });
            bridge = new ElainaPetBridge(petView, () -> {
                try {
                    Intent ai = new Intent(this, MainActivity.class);
                    ai.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT);
                    startActivity(ai);
                } catch (Exception e) { /* 忽略 */ }
            }, () -> dragging = true, () -> dragging = false, focused -> setInputFocus(focused));
            try { bridge.setModel(sp.getString("model", "")); } catch (Throwable ignored) { }
            petView.addJavascriptInterface(bridge, "PetBridge");
            petView.loadUrl("file:///android_asset/public/pet.html");

            /* 拖动手势（触摸头像/头部区域） */
            petView.setOnTouchListener((v, event) -> {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        /* 记录起点，否则首帧 MOVE 会用 rawX-0 把窗口甩出屏幕 */
                        lastTouchX = event.getRawX();
                        lastTouchY = event.getRawY();
                        return false;   /* 不消费 DOWN，保证 WebView 内部点击/输入正常 */
                    case MotionEvent.ACTION_MOVE:
                        if (!dragging || !draggable) return false;   /* OCR POS：设置里可关闭拖动（避免误触） */
                        /* gravity=TOP|RIGHT：x 是距右边缘距离，手指右移(x 增大)应使窗口左移 → 取负号（OCR 二轮 N1） */
                        lp.x = (int) (lp.x - (event.getRawX() - lastTouchX));
                        lp.y = (int) (lp.y + (event.getRawY() - lastTouchY));
                        lastTouchX = event.getRawX();
                        lastTouchY = event.getRawY();
                        clampToScreen(lp);
                        if (windowManager != null && petView != null) windowManager.updateViewLayout(petView, lp);
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        dragging = false;   /* JS 漏发 endDrag 时自愈（OCR 二轮 N2） */
                        savePosition(lp);   /* OCR POS：记住位置 */
                        return false;
                    default:
                        return false;
                }
            });
            windowManager.addView(petView, lp);
        } catch (Exception e) {
            /* 无悬浮窗权限：UserFeedback 由插件层引导 */
            stopSelf();
        }
    }
    private float lastTouchX = 0, lastTouchY = 0;
    private WindowManager.LayoutParams petParams;
    private volatile boolean dragging = false;
    private volatile boolean draggable = true;

    private void savePosition(WindowManager.LayoutParams lp) {
        try {
            getSharedPreferences("elaina_pet", MODE_PRIVATE).edit()
                    .putInt("posX", lp.x).putInt("posY", lp.y).apply();
        } catch (Throwable ignored) { }
    }

    /** 设置变更后热应用（尺寸 / 拖动开关 / 位置），无需重启服务 —— 供插件调用 */
    public static void applyConfigFromPrefs() {
        try {
            ElainaPetService s = instance;
            if (s == null || s.petView == null || s.petParams == null || s.windowManager == null) return;
            SharedPreferences sp = s.getSharedPreferences("elaina_pet", MODE_PRIVATE);
            float scale = 1f;
            try { scale = Math.max(0.6f, Math.min(1.6f, Float.parseFloat(sp.getString("scale", "1")))); } catch (Exception ignored) { }
            s.draggable = sp.getBoolean("draggable", true);
            WindowManager.LayoutParams lp = s.petParams;
            lp.width = s.dp((int) (300 * scale));
            lp.height = s.dp((int) (470 * scale));
            lp.x = sp.getInt("posX", lp.x);
            lp.y = sp.getInt("posY", lp.y);
            s.clampToScreen(lp);
            s.windowManager.updateViewLayout(s.petView, lp);
            s.savePosition(lp);
        } catch (Throwable ignored) { }
    }

    /** 输入焦点切换：悬浮窗默认 NOT_FOCUSABLE，输入框聚焦时需临时恢复焦点才能弹软键盘 */
    private void setInputFocus(final boolean focused) {
        /* OCR 二轮 5：JS 桥回调在后台线程，updateViewLayout 必须回主线程，否则抛 CalledFromWrongThreadException 并被吞 */
        handler.post(() -> {
            try {
                if (petParams == null || petView == null || windowManager == null) return;
                if (focused) {
                    petParams.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                    petParams.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
                    petParams.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_UNCHANGED
                            | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
                } else {
                    petParams.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                }
                windowManager.updateViewLayout(petView, petParams);
                if (focused) {
                    petView.requestFocus();
                    android.view.inputmethod.InputMethodManager imm = (android.view.inputmethod.InputMethodManager)
                            getSystemService(Context.INPUT_METHOD_SERVICE);
                    if (imm != null) imm.showSoftInput(petView, 0);
                }
            } catch (Throwable ignored) { }
        });
    }
    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    /** 状态栏高度（含刘海/挖孔安全区） */
    private int statusBarHeight() {
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) return getResources().getDimensionPixelSize(id);
        } catch (Throwable ignored) { }
        return dp(24);
    }

    /** 拖动时把悬浮窗钳制在屏幕内（gravity=TOP|RIGHT：x 为距右边缘距离） */
    private void clampToScreen(WindowManager.LayoutParams lp) {
        try {
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            int maxRight = Math.max(0, dm.widthPixels - lp.width);
            lp.x = Math.max(0, Math.min(lp.x, maxRight));
            int maxBottom = Math.max(0, dm.heightPixels - lp.height);
            lp.y = Math.max(0, Math.min(lp.y, maxBottom));
        } catch (Throwable ignored) { }
    }

    /* ---------- 定时主动回复 ---------- */
    private void scheduleLoop() {
        handler.removeCallbacks(proactiveLoop);
        handler.postDelayed(proactiveLoop, intervalMillis);
    }
    private final Runnable proactiveLoop = () -> {
        try {
            if (proactive && bridge != null) {
                String ctx = ElainaAccessibilityService.getLastContextText();
                long now = System.currentTimeMillis();
                if (ctx != null && !ctx.isEmpty() && now - lastProactiveAt > intervalMillis * 0.8) {
                    boolean fresh = now - ElainaAccessibilityService.getLastEventAt() < 4 * 60 * 1000L;
                    if (fresh) {
                        lastProactiveAt = now;
                        bridge.proactiveChat(ctx);
                    }
                }
            }
        } catch (Throwable e) { /* 忽略轮询异常 */ }
        scheduleLoop();
    };

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        /* OCR A2：服务停止即把开关状态落回 false，避免主界面开关仍显示「开」 */
        try { getSharedPreferences("elaina_pet", MODE_PRIVATE).edit().putBoolean("enabled", false).apply(); } catch (Throwable ignored) { }
        handler.removeCallbacksAndMessages(null);
        try {
            try { if (bridge != null) bridge.release(); } catch (Throwable ignored) { }   /* OCR 二轮 N7 */
            if (petView != null) {
                try { petView.stopLoading(); } catch (Exception ignored) { }
                try { petView.loadUrl("about:blank"); } catch (Exception ignored) { }
                try { petView.removeJavascriptInterface("PetBridge"); } catch (Exception ignored) { }
                try { petView.setWebChromeClient(null); } catch (Exception ignored) { }
                try { petView.setWebViewClient(new android.webkit.WebViewClient()); } catch (Exception ignored) { }
                try { petView.setOnTouchListener(null); } catch (Exception ignored) { }
                try { petView.removeAllViews(); } catch (Exception ignored) { }
                try { if (windowManager != null) windowManager.removeViewImmediate(petView); } catch (Exception ignored) { }
                try { petView.destroy(); } catch (Exception ignored) { }   /* 释放 Chromium 原生资源，避免 Service 泄漏 */
            }
        } catch (Exception e) { /* 忽略 */ }
        petView = null;
        bridge = null;
        windowManager = null;
        instance = null;
        super.onDestroy();
    }
}
