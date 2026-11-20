package dev.birdwatch.sdk;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ScenarioDriver {
  private final Application app = RuntimeEnvironment.getApplication();
  private final List<Long> sent = Collections.synchronizedList(new ArrayList<>());
  private final List<String> errors = Collections.synchronizedList(new ArrayList<>());
  private volatile long now, due, offset;
  private volatile Runnable tick;
  private volatile int active;
  private volatile boolean online = true;
  private final OkHttpClient http =
      new OkHttpClient.Builder().retryOnConnectionFailure(false).build();
  private Birdwatch client;
  private ActivityController<Activity> activity;

  private File db() {
    return new File(app.getNoBackupFilesDir(), "birdwatch-v1.sqlite3");
  }

  @Test
  public void sharedScenarios() throws Exception {
    Process node =
        new ProcessBuilder("node", "../conformance/android-driver.mjs")
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start();
    try (BufferedReader input =
            new BufferedReader(
                new InputStreamReader(node.getInputStream(), StandardCharsets.UTF_8));
        PrintWriter out =
            new PrintWriter(
                new OutputStreamWriter(node.getOutputStream(), StandardCharsets.UTF_8), true)) {
      for (String line; (line = input.readLine()) != null; ) {
        JSONObject msg = new JSONObject(line);
        try {
          out.println(command(msg));
        } catch (Exception e) {
          out.println(new JSONObject().put("failure", e.toString()));
          throw e;
        }
        if ("done".equals(msg.getString("op"))) break;
      }
      assertTrue(node.waitFor(15, TimeUnit.SECONDS));
      assertEquals(0, node.exitValue());
    } finally {
      close();
      node.destroyForcibly();
    }
  }

  private void close() throws Exception {
    if (client == null) return;
    // An app process can disappear without flushing its disk queue.
    client.stop().get(5, TimeUnit.SECONDS);
    client = null;
    if (activity != null) {
      activity.destroy();
      activity = null;
    }
    tick = null;
  }

  private JSONObject command(JSONObject msg) throws Exception {
    JSONObject reply = new JSONObject();
    switch (msg.getString("op")) {
      case "reset":
        close();
        for (File file : Objects.requireNonNull(app.getNoBackupFilesDir().listFiles()))
          if (file.getName().startsWith("birdwatch-v1.sqlite3")) Files.delete(file.toPath());
        sent.clear();
        errors.clear();
        online = true;
        offset = 0;
        break;
      case "open":
        now = msg.getLong("now");
        JSONObject config = msg.getJSONObject("config");
        JSONArray jitter = config.optJSONArray("jitter");
        int[] sample = {0};
        Birdwatch.Builder b =
            new Birdwatch.Builder(app, msg.getString("host"), "test")
                .maxQueueSize(config.optInt("capacity", 1000))
                .onError(e -> errors.add(e.getClass().getName()));
        b.flushInterval = 60000;
        b.wall = () -> now;
        b.elapsed = () -> now - offset;
        b.jitter = () -> jitter == null ? 0.5 : jitter.optDouble(sample[0]++, 0.5);
        b.timer =
            (state, task, delay) -> {
              due = now + delay;
              tick = () -> state.execute(task);
              return () -> tick = null;
            };
        b.transport =
            (url, body, timeout) -> {
              if (!online) throw new IOException("offline");
              sent.add(now);
              Request request =
                  new Request.Builder()
                      .url(url)
                      .post(RequestBody.create(body, MediaType.get("application/json")))
                      .build();
              try (Response res = http.newCall(request).execute()) {
                return new Collector.Response(
                    res.code(), res.body().string(), res.header("Retry-After"));
              }
            };
        client = b.build();
        activity = Robolectric.buildActivity(Activity.class).create().start().resume();
        break;
      case "enqueue":
        String id = msg.getString("id");
        CompletableFuture<String> saved =
            msg.getBoolean("generated")
                ? client.capture(id)
                : client.capture("example", null, id, now);
        saved.get(5, TimeUnit.SECONDS);
        break;
      case "status":
        if (client != null) {
          active = client.activeAttempts().get(5, TimeUnit.SECONDS);
        } else active = 0;
        if (tick != null) reply.put("due", due);
        reply
            .put("active", active)
            .put("sent", new JSONArray(sent))
            .put("errors", new JSONArray(errors));
        break;
      case "flush":
        client.flush();
        break;
      case "hide":
        activity.pause().stop();
        break;
      case "tick":
        now = msg.getLong("now");
        Runnable task = tick;
        tick = null;
        if (task != null) task.run();
        break;
      case "clock":
        long shift = msg.optLong("shift");
        offset += shift;
        if (tick != null) due += shift;
        now = msg.getLong("now");
        break;
      case "online":
        online = true;
        break;
      case "offline":
        online = false;
        break;
      case "close":
        close();
        break;
      case "corruptOutbox":
        close();
        try (FileOutputStream file = new FileOutputStream(db())) {
          file.write("{corrupt fixture".getBytes(StandardCharsets.UTF_8));
        }
        break;
      case "quarantined":
        boolean found = false;
        for (File f : Objects.requireNonNull(app.getNoBackupFilesDir().listFiles()))
          if (f.getName().contains(".corrupt-")
              && Arrays.equals(
                  Files.readAllBytes(f.toPath()),
                  "{corrupt fixture".getBytes(StandardCharsets.UTF_8))) found = true;
        reply.put("found", found);
        break;
      case "done":
        break;
      default:
        throw new AssertionError("Unknown Android conformance command");
    }
    return reply;
  }
}
