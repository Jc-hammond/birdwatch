package dev.birdwatch.sdk;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONException;
import org.json.JSONObject;

final class Collector {
  static final class HttpFailure extends IOException {
    final int status;
    final long delayMillis;

    HttpFailure(int status, long delayMillis) {
      super("Birdwatch collector returned HTTP " + status);
      this.status = status;
      this.delayMillis = delayMillis;
    }
  }

  final URL endpoint;
  private final int timeout;

  Collector(String host, int timeout) {
    try {
      URI uri = new URI(host);
      if (!("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
          || uri.getHost() == null
          || uri.getRawUserInfo() != null
          || uri.getRawQuery() != null
          || uri.getRawFragment() != null)
        throw new IllegalArgumentException(
            "Expected an HTTP(S) collector URL without credentials, query or fragment");
      endpoint = new URL(host.replaceAll("/+$", "") + "/api/capture");
    } catch (java.net.URISyntaxException | java.net.MalformedURLException e) {
      throw new IllegalArgumentException("Invalid collector URL", e);
    }
    this.timeout = timeout;
  }

  Birdwatch.Receipt send(Outbox.Row row) throws IOException {
    HttpURLConnection conn = (HttpURLConnection) endpoint.openConnection();
    try {
      conn.setInstanceFollowRedirects(false);
      conn.setUseCaches(false);
      conn.setConnectTimeout(timeout);
      conn.setReadTimeout(timeout);
      conn.setRequestMethod("POST");
      conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      byte[] bytes = row.body.getBytes(StandardCharsets.UTF_8);
      conn.setFixedLengthStreamingMode(bytes.length);
      try (OutputStream out = conn.getOutputStream()) {
        out.write(bytes);
      }
      int status = conn.getResponseCode();
      if (status < 200 || status >= 300)
        throw new HttpFailure(status, retryDelay(conn.getHeaderField("Retry-After")));
      try (InputStream in = conn.getInputStream()) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int count;
        while ((count = in.read(buffer)) != -1) {
          if (body.size() + count > 16384)
            throw new IOException("Oversized Birdwatch acknowledgement");
          body.write(buffer, 0, count);
        }
        JSONObject ack = new JSONObject(body.toString("UTF-8"));
        Object accepted = ack.get("accepted"), duplicates = ack.get("duplicates");
        if (Integer.valueOf(1).equals(accepted) && Integer.valueOf(0).equals(duplicates))
          return new Birdwatch.Receipt(row.id, 1, 0);
        if (Integer.valueOf(0).equals(accepted) && Integer.valueOf(1).equals(duplicates))
          return new Birdwatch.Receipt(row.id, 0, 1);
        throw new IOException("Invalid Birdwatch acknowledgement counts");
      } catch (JSONException e) {
        throw new IOException("Invalid Birdwatch acknowledgement", e);
      }
    } finally {
      conn.disconnect();
    }
  }

  private static long retryDelay(String header) {
    if (header == null) return 0;
    try {
      long seconds = Long.parseLong(header.trim());
      return Math.max(0, Math.min(seconds, Long.MAX_VALUE / 2000)) * 1000;
    } catch (NumberFormatException ignored) {
      SimpleDateFormat httpDate = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
      httpDate.setTimeZone(TimeZone.getTimeZone("GMT"));
      try {
        Date date = httpDate.parse(header);
        return date == null ? 0 : Math.max(0, date.getTime() - System.currentTimeMillis());
      } catch (java.text.ParseException invalid) {
        return 0;
      }
    }
  }
}
