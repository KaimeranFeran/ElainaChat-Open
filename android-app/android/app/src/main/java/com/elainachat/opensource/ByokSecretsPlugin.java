package com.elainachat.opensource;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "ByokSecrets")
public class ByokSecretsPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "elainachat_open_byok_v1";
    private static final String PREFS_NAME = "elainachat_open_encrypted_secrets";
    private static final Set<String> ALLOWED_NAMES = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList("apiKey", "minimaxApiKey", "dashscopeApiKey", "doubaoApiKey", "doubaoToken"))
    );

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private String decrypt(String stored) throws Exception {
        String[] parts = stored.split(":", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted secret");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }

    private String requireAllowedName(PluginCall call) {
        String name = call.getString("name", "");
        if (!ALLOWED_NAMES.contains(name)) {
            call.reject("Unsupported secret name");
            return null;
        }
        return name;
    }

    @PluginMethod
    public void getSecret(PluginCall call) {
        String name = requireAllowedName(call);
        if (name == null) return;
        String stored = preferences().getString(name, "");
        String value = "";
        if (!stored.isEmpty()) {
            try {
                value = decrypt(stored);
            } catch (Exception ignored) {
                preferences().edit().remove(name).apply();
            }
        }
        JSObject result = new JSObject();
        result.put("value", value);
        call.resolve(result);
    }

    @PluginMethod
    public void setSecret(PluginCall call) {
        String name = requireAllowedName(call);
        if (name == null) return;
        String value = call.getString("value", "").trim();
        try {
            SharedPreferences.Editor editor = preferences().edit();
            if (value.isEmpty()) editor.remove(name);
            else editor.putString(name, encrypt(value));
            editor.apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to store secret securely", error);
        }
    }

    @PluginMethod
    public void clearSecrets(PluginCall call) {
        SharedPreferences.Editor editor = preferences().edit();
        for (String name : ALLOWED_NAMES) editor.remove(name);
        editor.apply();
        call.resolve();
    }
}
