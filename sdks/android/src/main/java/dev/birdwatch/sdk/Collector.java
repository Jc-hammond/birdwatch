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
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

final class Collector {
  interface Transport {
    Response post(URL url, byte[] body, int timeout) throws IOException;
  }

  static final class Response {
    final int status;
    final String body;
    final String retryAfter;

    Response(int status, String body, String retryAfter) {
      this.status = status;
      this.body = body;
      this.retryAfter = retryAfter;
    }
  }

  static final class Failure extends IOException {
    final boolean pause, terminal;
    final long retryAfter;

    Failure(String message, boolean pause, boolean terminal, long retryAfter) {
      super(message);
      this.pause = pause;
      this.terminal = terminal;
      this.retryAfter = retryAfter;
    }
  }

  static final class Result {
    final int accepted, duplicates;
    final Map<Integer, Exception> rejected = new HashMap<>();

    Result(int accepted, int duplicates) {
      this.accepted = accepted;
      this.duplicates = duplicates;
    }
  }

  final URL endpoint;
  final String key;
  private final int timeout;
  private final Transport transport;

  Collector(String host, String key, int timeout, Transport transport) {
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
    this.key = key;
    this.timeout = timeout;
    this.transport = transport;
  }

  List<Outbox.Row> fit(List<Outbox.Row> rows) {
    int size = 80 + JSONObject.quote(key).getBytes(StandardCharsets.UTF_8).length;
    List<Outbox.Row> batch = new ArrayList<>();
    for (Outbox.Row row : rows) {
      size += 1 + row.body.getBytes(StandardCharsets.UTF_8).length;
      if (!batch.isEmpty() && (size > 1048576 || batch.size() == 100)) break;
      batch.add(row);
    }
    return batch;
  }

  Result send(List<Outbox.Row> rows, long now) throws Exception {
    SimpleDateFormat utc = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
    utc.setTimeZone(TimeZone.getTimeZone("UTC"));
    StringBuilder body =
        new StringBuilder("{\"api_key\":")
            .append(JSONObject.quote(key))
            .append(",\"sent_at\":\"")
            .append(utc.format(new Date(now)))
            .append("\",\"batch\":[");
    for (int i = 0; i < rows.size(); i++) {
      if (i != 0) body.append(',');
      body.append(rows.get(i).body);
    }
    byte[] bytes = body.append("]}").toString().getBytes(StandardCharsets.UTF_8);
    if (bytes.length > 1048576)
      throw new Failure("Event exceeds request size limit", false, true, -1);
    Response response = transport.post(endpoint, bytes, timeout);
    JSONObject ack;
    try {
      ack = new JSONObject(response.body);
    } catch (org.json.JSONException ignored) {
      ack = new JSONObject();
    }
    if (response.status != 200 || !ack.has("accepted")) {
      String code = ack.optString("code");
      boolean pause = response.status == 401 && code.equals("unknown_key");
      boolean terminal =
          (response.status == 400 && code.equals("invalid_event"))
              || (response.status == 413 && code.equals("too_large"));
      long delay = -1;
      if (response.retryAfter != null && response.retryAfter.matches("[0-9]+")) {
        try {
          delay = 1000 * Math.min(300L, Long.parseLong(response.retryAfter));
        } catch (NumberFormatException tooLarge) {
          delay = 300000;
        }
      }
      throw new Failure("Collector returned HTTP " + response.status, pause, terminal, delay);
    }
    int accepted = integer(ack, "accepted"), duplicates = integer(ack, "duplicates");
    JSONArray rejected = ack.getJSONArray("rejected");
    if ((long) accepted + duplicates + rejected.length() != rows.size())
      throw new IOException("Invalid Birdwatch acknowledgement counts");
    Result result = new Result(accepted, duplicates);
    for (int i = 0; i < rejected.length(); i++) {
      JSONObject item = rejected.getJSONObject(i);
      int index = integer(item, "index");
      String code = item.getString("code");
      if (index >= rows.size()
          || result.rejected.containsKey(index)
          || !(code.equals("invalid_event") || code.equals("too_large")))
        throw new IOException("Invalid Birdwatch rejection");
      result.rejected.put(index, new IllegalArgumentException("Collector rejected event: " + code));
    }
    return result;
  }

  private static int integer(JSONObject object, String name) throws Exception {
    Object value = object.get(name);
    if (!(value instanceof Integer) || (Integer) value < 0)
      throw new IOException("Invalid " + name);
    return (Integer) value;
  }

  static Response http(URL url, byte[] body, int timeout) throws IOException {
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    try {
      conn.setInstanceFollowRedirects(false);
      conn.setUseCaches(false);
      conn.setConnectTimeout(timeout);
      conn.setReadTimeout(timeout);
      conn.setRequestMethod("POST");
      conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
      conn.setFixedLengthStreamingMode(body.length);
      try (OutputStream out = conn.getOutputStream()) {
        out.write(body);
      }
      int status = conn.getResponseCode();
      // Consuming and closing the response allows Android to reuse its pooled connection.
      try (InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while (in != null && (n = in.read(buf)) != -1) {
          if (data.size() + n > 131072) throw new IOException("Oversized Birdwatch response");
          data.write(buf, 0, n);
        }
        return new Response(status, data.toString("UTF-8"), conn.getHeaderField("Retry-After"));
      }
    } catch (IOException | RuntimeException e) {
      conn.disconnect();
      throw e;
    }
  }
}
