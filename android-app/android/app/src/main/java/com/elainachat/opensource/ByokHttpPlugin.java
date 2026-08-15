package com.elainachat.opensource;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ByokHttp")
public class ByokHttpPlugin extends Plugin {
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void post(PluginCall call) {
        String urlValue = call.getString("url", "").trim();
        String body = call.getString("body", "");
        JSObject headers = call.getObject("headers", new JSObject());
        int requestedTimeout = call.getInt("timeoutMs", 120_000);
        int timeoutMs = Math.max(5_000, Math.min(180_000, requestedTimeout));
        executor.execute(() -> executePost(call, urlValue, body, headers, timeoutMs));
    }

    @PluginMethod
    public void get(PluginCall call) {
        String urlValue = call.getString("url", "").trim();
        int requestedTimeout = call.getInt("timeoutMs", 120_000);
        int timeoutMs = Math.max(5_000, Math.min(180_000, requestedTimeout));
        executor.execute(() -> executeGet(call, urlValue, timeoutMs));
    }

    private void executePost(PluginCall call, String urlValue, String body, JSObject headers, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlValue);
            if (!"https".equalsIgnoreCase(url.getProtocol())) {
                call.reject("Android direct requests require an HTTPS URL");
                return;
            }
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(Math.min(timeoutMs, 30_000));
            connection.setReadTimeout(timeoutMs);
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");

            Iterator<String> headerNames = headers.keys();
            while (headerNames.hasNext()) {
                String name = headerNames.next();
                String value = headers.optString(name, "");
                if (!name.isEmpty() && !value.isEmpty() && !"Host".equalsIgnoreCase(name)) {
                    connection.setRequestProperty(name, value);
                }
            }

            byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bodyBytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bodyBytes);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400
                ? connection.getInputStream()
                : connection.getErrorStream();
            String responseBody = stream == null ? "" : readLimitedUtf8(stream);

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("ok", status >= 200 && status < 300);
            result.put("body", responseBody);
            result.put("contentType", connection.getContentType() == null ? "" : connection.getContentType());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Direct provider request failed: " + error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void executeGet(PluginCall call, String urlValue, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlValue);
            if (!"https".equalsIgnoreCase(url.getProtocol())) {
                call.reject("Android direct requests require an HTTPS URL");
                return;
            }
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(Math.min(timeoutMs, 30_000));
            connection.setReadTimeout(timeoutMs);
            connection.setDoInput(true);
            connection.setRequestProperty("Accept", "*/*");

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400
                ? connection.getInputStream()
                : connection.getErrorStream();
            byte[] body = stream == null ? new byte[0] : readLimitedBinary(stream);

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("ok", status >= 200 && status < 300);
            result.put("body", Base64.encodeToString(body, Base64.NO_WRAP));
            result.put("contentType", connection.getContentType() == null ? "" : connection.getContentType());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Direct provider request failed: " + error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readLimitedUtf8(InputStream stream) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("Provider response is too large");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private byte[] readLimitedBinary(InputStream stream) throws Exception {
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("Provider response is too large");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }
}
