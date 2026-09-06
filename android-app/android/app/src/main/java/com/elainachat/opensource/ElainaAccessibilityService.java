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
        if (event == null) return;
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

    @Override
    public void onInterrupt() { }

    @Override
    public boolean onUnbind(Intent intent) {
        /* 无障碍被停用：记录（体验层可提示重新开启；此处返回 true 让系统重绑） */
        String tag = "";
        return super.onUnbind(intent);
    }
}
