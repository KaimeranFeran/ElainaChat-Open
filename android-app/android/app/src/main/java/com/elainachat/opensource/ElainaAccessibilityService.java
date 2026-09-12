package com.elainachat.opensource;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.HashSet;

/**
 * 无障碍读取前台界面文本（供桌宠主动回复 / 感知）。
 * 保活：系统以 BIND_ACCESSIBILITY_SERVICE 强绑定；被系统/用户停用时 onUnbind 记录。
 */
public class ElainaAccessibilityService extends AccessibilityService {

    private static volatile String lastContextText = "";
    private static volatile long lastEventAt = 0;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final HashSet<String> seen = new HashSet<>();

    public static String getLastContextText() { return lastContextText; }
    public static long getLastEventAt() { return lastEventAt; }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        AccessibilityServiceInfo info = getServiceInfo();
        if (info == null) return;
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.notificationTimeout = 120;
        info.flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        setServiceInfo(info);
        /* 无障碍就绪即拉起桌宠守护（保活组合） */
        try {
            Intent i = new Intent(this, ElainaPetService.class);
            if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception e) { /* 未开启桌宠时忽略 */ }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        /* OCR S4：跳过自身应用（避免桌宠/主界面内容自反馈回灌） */
        try {
            CharSequence pkg = event.getPackageName();
            if (pkg != null && getPackageName().contentEquals(pkg)) return;
        } catch (Throwable ignored) { }
        if (event == null) return;
        /* OCR A1：只有「主动回复」开启时才采集屏幕文本（关闭即停采，避免无谓读屏与耗电） */
        try {
            if (!getSharedPreferences("elaina_pet", MODE_PRIVATE).getBoolean("proactive", false)) {
                if (lastContextText != null && !lastContextText.isEmpty()) clearContextCache();
                return;
            }
        } catch (Throwable ignored) { }
        int t = event.getEventType();
        if (t != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && t != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return;
        handler.removeCallbacks(readRunnable);
        handler.postDelayed(readRunnable, 320); // 防抖
    }

    private final Runnable readRunnable = () -> {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return;
            StringBuilder sb = new StringBuilder(512);
            seen.clear();
            collect(root, sb, 0);
            root.recycle();
            String text = sb.toString().trim();
            if (text.isEmpty()) return;
            String sig = "len=" + text.length() + ":" + text.charAt(0);
            long now = System.currentTimeMillis();
            if (text.equals(lastContextText) && now - lastEventAt < 30000) return; // 变化去重
            seen.clear();
            lastContextText = text.length() > 6000 ? text.substring(0, 6000) : text;
            lastEventAt = now;
        } catch (Throwable e) { /* 无障碍节点偶发异常，忽略 */ }
    };

    private void collect(AccessibilityNodeInfo node, StringBuilder sb, int depth) {
        if (node == null || depth > 18 || sb.length() > 6000) return;
        CharSequence cs = node.getText();
        if (cs != null && cs.length() > 0) {
            String s = cs.toString().trim();
            if (!s.isEmpty() && seen.add(s)) { sb.append(s).append(' '); }
        }
        CharSequence cd = node.getContentDescription();
        if (cd != null && cd.length() > 0) {
            String s = cd.toString().trim();
            if (!s.isEmpty() && seen.add(s)) { sb.append(s).append(' '); }
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            if (sb.length() > 6000) return;
            AccessibilityNodeInfo child = node.getChild(i);
            collect(child, sb, depth + 1);
            if (child != null) child.recycle();
        }
    }

    /** OCR A5：无障碍被系统停用/中断时提示用户重新开启（否则桌宠静默失去上下文能力） */
    private void notifyContextLost() {
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            String ch = "elaina_pet_alert";
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                android.app.NotificationChannel c = new android.app.NotificationChannel(ch, "桌宠提示", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                nm.createNotificationChannel(c);
            }
            android.app.Notification.Builder b = (android.os.Build.VERSION.SDK_INT >= 26)
                    ? new android.app.Notification.Builder(this, ch)
                    : new android.app.Notification.Builder(this);
            b.setSmallIcon(android.R.drawable.ic_dialog_info)
             .setContentTitle("桌宠上下文已断开")
             .setContentText("无障碍服务被系统关闭，主动回复已停用。点此重新开启。")
             .setAutoCancel(true)
             .setContentIntent(android.app.PendingIntent.getActivity(this, 0,
                     new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS),
                     android.app.PendingIntent.FLAG_IMMUTABLE));
            nm.notify(4702, b.build());
        } catch (Throwable ignored) { }
    }

    @Override
    public void onInterrupt() { }

    private void clearContextCache() {
        lastContextText = "";
        lastEventAt = 0;
        try { handler.removeCallbacks(readRunnable); } catch (Throwable ignored) { }
        try { seen.clear(); } catch (Throwable ignored) { }
    }

    @Override
    public boolean onUnbind(Intent intent) {
        /* OCR A1/A5：清空缓存并提示用户重新开启无障碍 */
        clearContextCache();
        notifyContextLost();
        return super.onUnbind(intent);
    }
}
