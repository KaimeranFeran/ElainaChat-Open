package com.elainachat.opensource;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.util.PermissionHelper;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * 文件桥（不依赖系统文件选择器 / DocumentsUI / SAF）。
 *
 * <p>设计原因：部分 AOSP 系统缺少可用的 DocumentsUI，ACTION_OPEN_DOCUMENT /
 * ACTION_CREATE_DOCUMENT / WebView file input 都会被静默吞掉（ActivityNotFound → onReceiveValue(null)），
 * 而 MediaProvider（多媒体存储）与「图片上传」一样始终可用。因此：
 * <ul>
 *   <li>saveFile：通过 MediaStore 直接写入系统「下载/ElainaChat」目录（Android 10+ 无需权限）；</li>
 *   <li>listFiles：查询「下载」目录中 ElainaChat 前缀的文件（App 内展示列表，不弹系统界面）；</li>
 *   <li>readFile：按 uri 读取内容。</li>
 * </ul>
 */
@CapacitorPlugin(
        name = "FileBridge",
        permissions = {
                @Permission(alias = "storage", strings = {
                        Manifest.permission.WRITE_EXTERNAL_STORAGE,
                        Manifest.permission.READ_EXTERNAL_STORAGE
                })
        }
)
public class FileBridgePlugin extends Plugin {

    private PluginCall pendingSaveCall;
    private String pendingSaveFilename;
    private String pendingSaveMime;
    private byte[] pendingSaveBytes;

    @PluginMethod
    public void saveFile(PluginCall call) {
        String filename = call.getString("filename", "export.txt");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        byte[] bytes = decodeBytes(data);
        if (bytes == null) {
            call.reject("数据解码失败");
            return;
        }

        // Android 9 及以下：写入公共下载目录需要 WRITE_EXTERNAL_STORAGE 运行时权限
        if (Build.VERSION.SDK_INT < 29) {
            if (!hasStoragePermission()) {
                this.pendingSaveCall = call;
                this.pendingSaveFilename = filename;
                this.pendingSaveMime = mime;
                this.pendingSaveBytes = bytes;
                requestPermissionForAliases(new String[]{"storage"}, call, "storageGranted");
                return;
            }
        }

        try {
            doSaveFile(filename, mime, bytes, call);
        } catch (Exception e) {
            call.reject("保存失败: " + e.getMessage());
        }
    }

    @PermissionCallback
    public void storageGranted(PluginCall call) {
        if (!hasStoragePermission()) {
            call.reject("需要「存储」权限才能保存到下载目录");
            pendingSaveCall = null;
            pendingSaveBytes = null;
            pendingSaveFilename = null;
            pendingSaveMime = null;
            return;
        }
        PluginCall saved = this.pendingSaveCall;
        String filename = this.pendingSaveFilename;
        String mime = this.pendingSaveMime;
        byte[] bytes = this.pendingSaveBytes;
        this.pendingSaveCall = null;
        this.pendingSaveFilename = null;
        this.pendingSaveMime = null;
        this.pendingSaveBytes = null;
        if (saved == null) return;
        try {
            doSaveFile(filename, mime, bytes, saved);
        } catch (Exception e) {
            saved.reject("保存失败: " + e.getMessage());
        }
    }

    private void doSaveFile(String filename, String mime, byte[] bytes, PluginCall call) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ElainaChat");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = getContext().getContentResolver().insert(
                    MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL), values);
            if (uri == null) {
                call.reject("无法访问多媒体存储（MediaProvider 不可用）");
                return;
            }
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "w")) {
                if (out == null) {
                    getContext().getContentResolver().delete(uri, null, null);
                    call.reject("无法打开输出流");
                    return;
                }
                out.write(bytes);
                out.flush();
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(uri, done, null, null);

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("filename", filename);
            ret.put("uri", uri.toString());
            ret.put("location", "下载/ElainaChat/" + filename);
            call.resolve(ret);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ElainaChat");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("无法创建下载目录");
                return;
            }
            File file = new File(dir, filename);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
                out.flush();
            }
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("filename", filename);
            ret.put("uri", Uri.fromFile(file).toString());
            ret.put("location", "下载/ElainaChat/" + filename);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        String prefix = call.getString("prefix", "ElainaChat");
        List<JSObject> files = new ArrayList<>();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                Uri uri = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL);
                String[] projection = {
                        MediaStore.MediaColumns._ID,
                        MediaStore.MediaColumns.DISPLAY_NAME,
                        MediaStore.MediaColumns.SIZE,
                        MediaStore.MediaColumns.DATE_MODIFIED
                };
                try (Cursor c = cr.query(uri, projection,
                        MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?",
                        new String[]{prefix + "%"},
                        MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
                    if (c != null) {
                        while (c.moveToNext()) {
                            JSObject o = new JSObject();
                            long id = c.getLong(c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID));
                            o.put("name", c.getString(c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)));
                            o.put("size", c.getLong(c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)));
                            o.put("date", c.getLong(c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)));
                            o.put("uri", android.content.ContentUris.withAppendedId(uri, id).toString());
                            files.add(o);
                        }
                    }
                }
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ElainaChat");
                if (dir.exists()) {
                    File[] entries = dir.listFiles();
                    if (entries != null) {
                        Arrays.sort(entries, new Comparator<File>() {
                            @Override
                            public int compare(File a, File b) {
                                return Long.compare(b.lastModified(), a.lastModified());
                            }
                        });
                        for (File f : entries) {
                            if (f.isFile() && f.getName().startsWith(prefix)) {
                                JSObject o = new JSObject();
                                o.put("name", f.getName());
                                o.put("size", f.length());
                                o.put("date", f.lastModified() / 1000);
                                o.put("uri", Uri.fromFile(f).toString());
                                files.add(o);
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            call.reject("列出文件失败: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        JSArray arr = new JSArray();
        for (JSObject o : files) {
            arr.put(o);
        }
        ret.put("files", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String uriStr = call.getString("uri", "");
        if (uriStr.isEmpty()) {
            call.reject("缺少 uri 参数");
            return;
        }
        try {
            Uri uri = Uri.parse(uriStr);
            String displayName = queryDisplayName(uri);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                if (in == null) {
                    call.reject("无法打开文件");
                    return;
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] tmp = new byte[16384];
                int read;
                while ((read = in.read(tmp)) != -1) {
                    buffer.write(tmp, 0, read);
                }
                JSObject ret = new JSObject();
                ret.put("name", displayName == null ? "" : displayName);
                ret.put("content", new String(buffer.toByteArray(), StandardCharsets.UTF_8));
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("读取失败: " + e.getMessage());
        }
    }

    private boolean hasStoragePermission() {
        return PermissionHelper.hasPermissions(getContext(), new String[]{
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
                Manifest.permission.READ_EXTERNAL_STORAGE
        });
    }

    private byte[] decodeBytes(String data) {
        String base64 = data;
        if (base64.startsWith("data:")) {
            int comma = base64.indexOf(',');
            if (comma >= 0) base64 = base64.substring(comma + 1);
        }
        try {
            return android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        } catch (Exception e) {
            try {
                return data.getBytes(StandardCharsets.UTF_8);
            } catch (Exception e2) {
                return null;
            }
        }
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
        }
        return uri.getLastPathSegment() != null ? uri.getLastPathSegment() : null;
    }
}