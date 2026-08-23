package com.elainachat.opensource;

import android.content.Intent;
import android.net.Uri;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 记忆/文件导入导出的原生桥接。
 * - exportFile: 用系统 "保存文件" (ACTION_CREATE_DOCUMENT) 唤起文件管理器，用户选位置后写入内容。
 * - importFile: 用系统 "打开文件" (ACTION_OPEN_DOCUMENT) 唤起文件选择器，读取所选文件的文本内容。
 */
@CapacitorPlugin(name = "DocumentFile")
public class DocumentFilePlugin extends Plugin {

    private byte[] pendingExportBytes;
    private String pendingExportName;

    @PluginMethod
    public void exportFile(PluginCall call) {
        String filename = call.getString("filename", "export.txt");
        String mime = call.getString("mime", "text/plain");
        String data = call.getString("data", "");

        String base64 = data;
        if (base64.startsWith("data:")) {
            int comma = base64.indexOf(',');
            if (comma >= 0) base64 = base64.substring(comma + 1);
        }
        byte[] bytes;
        try {
            bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        } catch (Exception error) {
            bytes = data.getBytes(StandardCharsets.UTF_8);
        }

        this.pendingExportBytes = bytes;
        this.pendingExportName = filename;

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "exportCallback");
    }

    @ActivityCallback
    private void exportCallback(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            clearPendingExport();
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("no-uri");
            clearPendingExport();
            return;
        }
        String name = pendingExportName != null ? pendingExportName : "export.txt";
        byte[] bytes = pendingExportBytes != null ? pendingExportBytes : new byte[0];
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "w")) {
            if (out == null) throw new Exception("无法打开输出流");
            out.write(bytes);
            out.flush();
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("filename", name);
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("write-failed:" + error.getMessage());
        } finally {
            clearPendingExport();
        }
    }

    @PluginMethod
    public void importFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        String[] mimeTypes = {"application/json", "text/plain", "application/octet-stream"};
        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        startActivityForResult(call, intent, "importCallback");
    }

    @ActivityCallback
    private void importCallback(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("no-uri");
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("无法打开输入流");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] temp = new byte[8192];
            int read;
            while ((read = in.read(temp)) != -1) buffer.write(temp, 0, read);
            String content = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            String displayName = queryDisplayName(uri);
            JSObject ret = new JSObject();
            ret.put("name", displayName);
            ret.put("content", content);
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("read-failed:" + error.getMessage());
        }
    }

    private void clearPendingExport() {
        pendingExportBytes = null;
        pendingExportName = null;
    }

    private String queryDisplayName(Uri uri) {
        try (android.database.Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
        }
        return uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "import.json";
    }
}
