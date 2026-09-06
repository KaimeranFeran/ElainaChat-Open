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
        instance = this;
        startForegroundCompat();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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
            if (clickthrough) petFlags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    dp((int) (300 * petScale)), dp((int) (470 * petScale)),
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    petFlags,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.RIGHT;
            lp.x = dp(8);
            lp.y = dp(120);

            petView = new WebView(this);
            WebSettings ws = petView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setAllowFileAccess(true);
            ws.setAllowFileAccessFromFileURLs(true);
            ws.setAllowUniversalAccessFromFileURLs(true);
            ws.setCacheMode(WebSettings.LOAD_DEFAULT);
            petView.setBackgroundColor(Color.TRANSPARENT);
            petView.setOverScrollMode(View.OVER_SCROLL_NEVER);

            bridge = new ElainaPetBridge(petView, () -> {
                try {
                    Intent ai = new Intent(this, MainActivity.class);
                    ai.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT);
                    startActivity(ai);
                } catch (Exception e) { /* 忽略 */ }
            });
            petView.addJavascriptInterface(bridge, "PetBridge");
            petView.loadUrl("file:///android_asset/public/pet.html");

            /* 拖动手势（触摸头像/头部区域） */
            petView.setOnTouchListener((v, event) -> {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        return false;
                    case MotionEvent.ACTION_MOVE:
                        lp.x = (int) (lp.x + (event.getRawX() - lastTouchX));
                        lp.y = (int) (lp.y + (event.getRawY() - lastTouchY));
                        lastTouchX = event.getRawX();
                        lastTouchY = event.getRawY();
                        if (windowManager != null && petView != null) windowManager.updateViewLayout(petView, lp);
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        return false;
                    default:
                        return false;
                }
            });
            windowManager.addView(petView, lp);
            lastTouchX = 0; lastTouchY = 0;
        } catch (Exception e) {
            /* 无悬浮窗权限：UserFeedback 由插件层引导 */
            stopSelf();
        }
    }
    private float lastTouchX = 0, lastTouchY = 0;
    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

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
        handler.removeCallbacks(proactiveLoop);
        try {
            if (petView != null && windowManager != null) windowManager.removeView(petView);
        } catch (Exception e) { /* 已移除 */ }
        petView = null;
        instance = null;
        super.onDestroy();
    }
}
